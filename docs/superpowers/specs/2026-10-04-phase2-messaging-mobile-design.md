# RestoTalk Phase 2 — Messagerie & App Mobile

Date: 2026-10-04
Statut: validé en brainstorming, en attente de revue finale avant plan d'implémentation.
Dépend de: [2026-10-04-restotalk-design.md](2026-10-04-restotalk-design.md) (sections 2, 3, 5), implémenté en Phase 1.

## 1. Contexte et objectif

Deuxième phase de construction de RestoTalk (ordre défini en section 14 de la spec globale). Cette phase livre :
1. L'extension du backend NestJS avec le domaine de messagerie (`TableContact`, `Message`) déjà modélisé en Phase 1.
2. La première application mobile React Native du projet : scan du QR code de table, saisie du pseudo, liste des tables occupées en temps réel, et messagerie (SMS interne) entre tables avec autorisation one-time par paire.

Hors périmètre de cette phase (phases suivantes) : appel vocal (Agora/Twilio), back-office web, notifications push FCM.

## 2. Décisions prises pour cette phase

- **Persistance de session** : le token de session est stocké dans `expo-secure-store` ; au lancement de l'app, un token valide (vérifié via `GET /sessions/me`) évite un nouveau scan QR tant qu'il n'a pas expiré (6h) ou été invalidé côté serveur.
- **Plateforme cible** : validation sur Android uniquement pour cette phase (émulateur ou appareil via EAS dev client) ; iOS sera validé dans une phase ultérieure.
- **Gestion d'état** : React Context + hooks, sans bibliothèque de state management supplémentaire — suffisant pour le nombre d'écrans de cette phase.
- **Scan QR** : `expo-camera` (scan de code-barres intégré), cohérent avec l'usage d'Expo Dev Client déjà retenu en Phase 1.
- **Navigation** : `@react-navigation/native` + native-stack.

## 3. Extension backend

### 3.1 Modèle de données

Déjà défini en Phase 1 (spec globale section 3) : `TableContact` et `Message`. Aucune migration Prisma nouvelle nécessaire au-delà de ce qui existe déjà — ces deux modèles seront ajoutés au schéma Prisma dans cette phase (ils n'avaient pas encore été migrés, seuls `Table`/`ClientSession` l'ont été en Phase 1).

```
TableContact
  id, table_a_id → Table, table_b_id → Table,
  status [pending | accepted | refused],
  requested_by_session_id → ClientSession, created_at, responded_at

Message
  id, contact_id → TableContact, sender_session_id → ClientSession,
  kind [predefined | freetext], predefined_code (nullable), content,
  created_at
```

### 3.2 Endpoints REST

- `GET /tables/occupied` — liste des tables occupées hors la sienne, avec nombre de sessions actives. Expose `TablesService.listOccupied` (déjà implémenté en Phase 1 pour le gateway, désormais aussi exposé via un contrôleur REST).
- `POST /messages` — body `{ toTableId: number, kind: 'predefined' | 'freetext', predefinedCode?: string, content?: string }`. Si aucun `TableContact` `accepted` n'existe entre les deux tables (dans les deux sens), crée ou réutilise un `TableContact` `pending` et renvoie `{ status: 'pending_approval', contactId }` sans délivrer le message ; si un contact `accepted` existe déjà, crée directement le `Message` et renvoie `{ status: 'sent', message }`.
- `POST /contacts/:contactId/respond` — body `{ accept: boolean }`. Réservé aux sessions de la table destinataire du contact. Si `accept: true`, passe le contact à `accepted` et délivre le message initial (déjà stocké en base, marqué visible seulement à partir de maintenant) ; si `accept: false`, passe à `refused`.
- `GET /contacts/:contactId/messages` — historique des messages d'un contact `accepted`, réservé aux sessions de l'une des deux tables du contact.

### 3.3 Événements Socket.io

En plus de `tables:update` (Phase 1), trois nouveaux événements émis via `EventEmitter2` et relayés par `RealtimeGateway` (nouveaux `@OnEvent` listeners, même pattern que `table.presence.changed`) :

- `contact:request` → poussé aux sessions de la table destinataire : `{ contactId, fromTableId, fromTableNumber }` (sans contenu de message).
- `contact:resolved` → poussé aux sessions de la table demandeuse : `{ contactId, status: 'accepted' | 'refused' }`.
- `message:new` → poussé aux sessions des deux tables d'un contact accepté : `{ contactId, message }`.

### 3.4 Autorisation

Les trois nouveaux endpoints sont protégés par `SessionAuthGuard` (Phase 1, inchangé). `POST /contacts/:contactId/respond` vérifie en plus que la session appelante appartient bien à la table destinataire du contact (403 sinon). `GET /contacts/:contactId/messages` vérifie que la session appartient à l'une des deux tables du contact.

## 4. Application mobile

### 4.1 Écrans (React Navigation, native stack)

1. **ScanScreen** — caméra (`expo-camera`), décode le QR en `{ tableId, secret }`.
2. **PseudoScreen** — saisie du pseudo, `POST /sessions`, stockage du token dans `expo-secure-store`.
3. **TableListScreen** — liste temps réel des tables occupées (`GET /tables/occupied` au chargement + écoute `tables:update`), bannière de demande de contact entrante (`contact:request`).
4. **ChatScreen** (par contact) — historique (`GET /contacts/:id/messages`), messages prédéfinis + texte libre, envoi (`POST /messages`), réception live (`message:new`).
5. **Modale de demande de contact** — accepter/refuser (`POST /contacts/:id/respond`), déclenchée par l'événement `contact:request`.

### 4.2 Démarrage de l'app

Au lancement : lecture du token dans `SecureStore` → si présent, validation via `GET /sessions/me` → si valide (200), connexion Socket.io (token en handshake `auth`, comme en Phase 1) et navigation directe vers `TableListScreen` ; si absent ou invalide (401), navigation vers `ScanScreen` et suppression du token périmé du `SecureStore`.

### 4.3 État global

Un `SessionContext` (React Context + hooks) expose :
- la session courante (`token`, `tableId`, `pseudo`),
- l'instance du client Socket.io et son statut de connexion,
- la liste des tables occupées, tenue à jour par l'événement `tables:update`,
- les demandes de contact entrantes en attente (`contact:request` reçus et non encore traités).

### 4.4 Dépendances nouvelles

`expo-camera`, `@react-navigation/native`, `@react-navigation/native-stack`, `expo-secure-store`, `socket.io-client`.

## 5. Gestion des erreurs et cas limites

| Cas | Comportement |
|---|---|
| Token persisté mais expiré/session invalidée | `GET /sessions/me` renvoie 401 au démarrage → token supprimé du SecureStore, retour à `ScanScreen` |
| Tentative de contact vers une table qui vient de se libérer | `POST /messages` renvoie une erreur si `toTableId` n'est plus `occupied` ; l'app rafraîchit la liste |
| Double demande de contact simultanée dans les deux sens | Comportement déjà tranché en Phase 1 (spec globale section 11/13) : deux `TableContact` indépendants, pas de fusion automatique |
| Perte de connexion Socket.io pendant l'usage de l'app | L'app affiche un indicateur de connexion et tente une reconnexion automatique (comportement par défaut de `socket.io-client`) ; au rétablissement, `TableListScreen` refait un `GET /tables/occupied` pour resynchroniser l'état |
| Réponse à un contact déjà résolu (double-clic accepter/refuser) | Le backend renvoie une erreur si le `TableContact` n'est plus `pending` ; l'app ignore silencieusement une réponse en double |

## 6. Stratégie de tests

- **Backend** : tests unitaires NestJS sur le service de messagerie (règles `TableContact` : création/réutilisation d'un contact pending, transition accepted/refused, autorisation des endpoints), tests d'intégration sur les routes REST avec Postgres de test (même approche qu'en Phase 1).
- **Socket.io** : test d'intégration simulant deux clients connectés vérifiant la délivrance de `contact:request`, `contact:resolved`, `message:new`.
- **Mobile** : tests unitaires sur la logique de `SessionContext` (persistance/validation du token, mise à jour de la liste des tables) ; test manuel guidé pour le flux complet scan → pseudo → liste → demande de contact → chat (caméra difficile à automatiser en CI).

## 7. Hors périmètre de cette phase

- Appel vocal (Agora/Twilio) — Phase 3.
- Back-office web — Phase 4.
- Notifications push FCM — Phase 5 (l'app reste au premier plan pendant cette phase ; les événements Socket.io ne sont reçus que si l'app est ouverte).
- Validation iOS — phase ultérieure.
