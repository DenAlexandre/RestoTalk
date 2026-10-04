# RestoTalk — Design

Date: 2026-10-04
Statut: validé en brainstorming, en attente de revue finale avant plan d'implémentation.

## 1. Contexte et objectif

Application mobile pour un pilote réel dans un restaurant. Un client scanne le QR code posé sur sa table, choisit un pseudo, et peut ensuite envoyer des messages (SMS internes) ou passer de vrais appels vocaux (voix, via internet, pas de réseau téléphonique) à une autre table occupée du même restaurant. Le destinataire doit systématiquement pouvoir accepter ou refuser. Le personnel dispose d'un back-office web pour superviser les tables et consulter l'historique.

Périmètre de cette version : un seul restaurant (pas de multi-tenant), nombre de tables fixé par un fichier de configuration.

## 2. Architecture d'ensemble

```
┌─────────────────────┐        ┌─────────────────────┐
│  App mobile client   │        │  Back-office web      │
│  (React Native +      │        │  (React, staff only)  │
│  Expo Dev Client)     │        │                        │
└──────────┬───────────┘        └──────────┬───────────┘
           │ REST + WebSocket (Socket.io)   │ REST
           ▼                                ▼
        ┌─────────────────────────────────────┐
        │        Backend NestJS               │
        │  - API REST (scan QR, historique)   │
        │  - Gateway Socket.io (temps réel)    │
        │  - Dispatch push (FCM)              │
        │  - Génération token Agora            │
        └───────────────┬─────────────────────┘
                         │
          ┌──────────────┼───────────────┐
          ▼              ▼               ▼
   ┌─────────────┐ ┌───────────┐  ┌──────────────┐
   │ PostgreSQL  │ │  Firebase │  │ Agora (ou     │
   │ (Prisma)    │ │  Cloud    │  │ Twilio) Voice │
   │             │ │ Messaging │  │ — flux audio  │
   └─────────────┘ └───────────┘  └──────────────┘
```

- **App mobile** (React Native, Expo avec *dev client* EAS — nécessaire car scanner QR natif, SDK Agora et FCM requièrent des modules natifs non disponibles dans Expo Go) : scan QR → pseudo → liste des tables occupées → messagerie / appel.
- **Backend NestJS** : seul point de vérité métier. Valide les QR (token signé), gère les sessions clients, la messagerie, la signalisation d'appel, génère les tokens d'accès Agora à la demande (aucune clé Agora côté mobile).
- **Back-office web (React)** : réservé au personnel authentifié, supervision des tables et historique en lecture seule.
- **PostgreSQL** : unique source de données persistantes.
- **Agora** (ou Twilio Voice comme alternative équivalente) : héberge le flux audio du canal ; le backend ne relaie jamais l'audio lui-même, seulement les tokens d'accès.
- **Firebase Cloud Messaging** : relaie les événements critiques (message, demande de contact, appel entrant) quand l'app est en arrière-plan ou fermée.

## 3. Modèle de données (PostgreSQL via Prisma)

```
Table
  id, number (unique), qr_token_secret, status [free | occupied], created_at

ClientSession
  id, table_id → Table, pseudo, push_token (FCM, nullable),
  joined_at, last_seen_at, left_at (nullable),
  status [active | expired | left | kicked_by_staff]

TableContact            -- autorisation one-time par paire de tables
  id, table_a_id → Table, table_b_id → Table,
  status [pending | accepted | refused],
  requested_by_session_id → ClientSession, created_at, responded_at

Message
  id, contact_id → TableContact, sender_session_id → ClientSession,
  kind [predefined | freetext], predefined_code (nullable), content,
  created_at

Call
  id, from_table_id → Table, to_table_id → Table,
  caller_session_id → ClientSession,
  status [ringing | accepted | refused | missed | ended],
  agora_channel_name, started_at, answered_at, ended_at, duration_seconds

StaffUser
  id, username, password_hash
```

Notes :
- Pas de compte client persistant : `ClientSession` est éphémère, recréée à chaque scan. Le pseudo n'existe que pour la durée de la session.
- `TableContact` matérialise l'autorisation one-time entre deux tables ; une fois `accepted`, tous les `Message` suivants entre ces deux tables circulent sans nouvelle demande, pour toute la durée des sessions concernées.
- `Call` est indépendant de `TableContact` : chaque appel redemande systématiquement l'autorisation (sonnerie classique, pas d'effet de "contact accepté" permanent pour les appels).
- Le nombre de tables vient du fichier de config au démarrage du backend ; les `Table` manquantes sont créées, aucune n'est jamais supprimée automatiquement (préservation de l'historique).

## 4. Flux QR code et session

1. Le QR imprimé encode un token signé (JWT `{table_id, restaurant_id}`, signé par le backend, longue durée de vie). Il est régénérable manuellement depuis le back-office (invalide l'ancien, nécessite réimpression) en cas de suspicion de copie/fuite.
2. L'app scanne le QR, envoie le token à `POST /sessions`. Le backend vérifie la signature et l'existence de la table, puis demande le pseudo côté app. La `ClientSession` est créée et le backend renvoie un **token de session** applicatif (JWT court, ex. 6h), utilisé pour toutes les requêtes REST et la connexion Socket.io suivantes.
3. La table passe en statut `occupied` dès qu'au moins une session y est `active`, et repasse `free` quand plus aucune session active n'y est rattachée.

### Fin de session
- **Inactivité** : une vérification périodique (job planifié) marque `expired` toute `ClientSession` sans activité depuis `sessionInactivityTimeoutHours` (valeur du fichier de config). Le client est déconnecté et renvoyé à l'écran de scan.
- **Reset staff** : le back-office peut forcer `kicked_by_staff` sur toutes les sessions actives d'une table → la table repasse `free` immédiatement.

### Liste des tables contactables
L'app affiche en temps réel (Socket.io) la liste des tables `occupied` autres que la sienne, avec le nombre de sessions actives. Seules ces tables sont sélectionnables pour un message ou un appel (condition "au moins 1 personne").

## 5. Flux de messagerie (SMS interne)

Contenu : liste de messages prédéfinis (configurable côté backend, ex. "Santé !", "On vous invite à un verre") + possibilité de texte libre.

1. Table A choisit Table B, sélectionne un message (prédéfini ou libre) → `POST /messages`.
2. S'il n'existe pas déjà de `TableContact` à l'état `accepted` entre A et B, le backend crée (ou réutilise) un `TableContact` `pending` et notifie B (Socket.io + push FCM) : *"La table 5 souhaite vous envoyer un message"*, sans révéler le contenu avant acceptation.
3. B accepte → le `TableContact` passe `accepted` ; le message initial est délivré ; tous les messages suivants entre A et B circulent ensuite librement, sans nouvelle demande, jusqu'à la fin des sessions concernées.
4. B refuse → `TableContact` repasse disponible pour une nouvelle tentative : A peut renvoyer une demande de contact plus tard dans le repas (pas de blocage définitif).

## 6. Flux d'appel vocal

1. Table A sélectionne Table B dans la liste des tables occupées → `POST /calls`.
2. Si B est déjà en communication, ou a déjà un appel `ringing` en attente d'un autre appelant, le backend répond immédiatement **occupé** à A, sans faire sonner B.
3. Sinon, un `Call` est créé en `ringing`. Tous les appareils connectés à la table B reçoivent la sonnerie (Socket.io + push FCM) : *"Table 3 vous appelle"*. Le premier qui répond (accepte ou refuse) fait foi ; la sonnerie est annulée sur les autres appareils de B.
4. **Accepté** → le backend génère un token Agora par appareil impliqué (A et le répondant de B) pour le salon `call-<id>`, statut `accepted`. Les deux apps rejoignent le salon Agora et l'audio démarre. Seuls l'appelant et la personne qui a décroché sont dans l'appel — les autres personnes de la table ne sont pas automatiquement embarquées.
5. **Refusé** → statut `refused`, A est notifié.
6. **Pas de réponse sous 30 secondes** → statut `missed`, A est notifié, la sonnerie s'arrête chez B.
7. **Fin d'appel** → l'un ou l'autre raccroche, statut `ended`, durée calculée et stockée.

## 7. Back-office web (staff)

- Authentification (`StaffUser`, mot de passe hashé bcrypt, session JWT).
- Vue d'ensemble des tables : statut (libre/occupée), nombre de personnes connectées.
- Action **"Libérer la table"** : force la fin de toutes les sessions actives de cette table.
- Historique en lecture seule : messages échangés et appels passés (horodatage, tables concernées, durée) — à but d'audit/support, pas de modération active dans cette version.
- Visualisation du QR actuel de chaque table + action **"Régénérer le QR"**.

## 8. Fichier de configuration

Chargé au démarrage du backend :

```yaml
restaurant:
  name: "Le Bistrot"
  tableCount: 20
  sessionInactivityTimeoutHours: 4
  predefinedMessages:
    - code: "sante"
      text: "Santé !"
    - code: "invite_verre"
      text: "On vous invite à un verre"
```

Au démarrage, le backend s'assure que les lignes `Table` 1..`tableCount` existent (création des manquantes), sans jamais supprimer une table existante.

## 9. Notifications et présence temps réel

- **Premier plan** : Socket.io pour tout événement instantané (présence des tables, messages, demandes de contact, sonnerie d'appel).
- **Arrière-plan / app fermée** : FCM relaie en push les mêmes événements critiques. Au retour au premier plan, l'app resynchronise son état via REST (sessions, messages non vus, appels manqués).
- Le `push_token` FCM est enregistré/mis à jour sur `ClientSession` à chaque démarrage de l'app.

## 10. Sécurité

- Le JWT de session client est requis sur toutes les routes REST et sur la connexion Socket.io.
- Le token QR est signé côté serveur ; une table ne peut pas être usurpée sans connaître le secret serveur.
- Les clés Agora/Twilio restent exclusivement côté backend ; seuls des tokens de canal à durée de vie courte sont transmis au mobile.
- Rate limiting basique sur `POST /messages` et `POST /calls` par `ClientSession` pour limiter le spam (ex. 1 demande de contact par table cible toutes les 30s).
- Le texte libre des messages n'est pas modéré activement dans cette version (noté comme limite connue, cf. section Hors périmètre).

## 11. Gestion des erreurs et cas limites

| Cas | Comportement |
|---|---|
| QR invalide/périmé scanné | Message d'erreur explicite, pas de session créée |
| Table déjà "pleine" (pas de limite de personnes par table dans cette version) | Pas de limite imposée — plusieurs pseudos peuvent rejoindre la même table |
| Appel vers une table qui vient de passer `free` entre l'affichage de la liste et le clic | Backend renvoie une erreur "table non disponible", l'app rafraîchit la liste |
| Perte de connexion réseau pendant un appel en cours | L'app tente une reconnexion Agora ; au-delà d'un délai (ex. 15s), l'appel est marqué `ended` côté backend |
| Double tentative de contact simultanée (A→B et B→A en même temps) | Chaque sens crée/consulte son propre `TableContact` ; l'acceptation de l'un n'autorise pas automatiquement l'autre sens tant que les deux ne sont pas acceptés — *à confirmer si contre-intuitif, cf. section 13* |
| Session expirée pendant un appel/échange en cours | La session expirée est déconnectée ; l'appel en cours est terminé proprement (`ended`), les messages déjà envoyés restent en base |

## 12. Stratégie de tests

- **Backend** : tests unitaires NestJS sur les services métier (validation QR, règles de `TableContact`, machine à états de `Call`), tests d'intégration sur les routes REST critiques avec une base Postgres de test (ex. via conteneur Docker éphémère).
- **Socket.io** : tests d'intégration simulant deux clients connectés pour vérifier la délivrance des événements (demande de contact, sonnerie, annulation sur double réponse).
- **Mobile** : tests unitaires sur la logique de session/état local ; test manuel guidé pour le flux QR → pseudo → appel (caméra et SDK Agora difficiles à automatiser en CI).
- **Back-office** : tests unitaires sur les composants d'affichage d'état, test manuel pour l'action "Libérer la table" avant mise en prod.

## 13. Hors périmètre de cette version (pistes futures)

- Multi-restaurants (multi-tenant).
- Modération automatique du texte libre.
- Rotation automatique/périodique des QR codes (uniquement régénération manuelle en v1).
- Plusieurs participants simultanés dans un même appel (au-delà d'un binôme appelant/répondant).
- Cas "double demande de contact simultanée dans les deux sens" (section 11) : comportement simple retenu pour le MVP (deux `TableContact` indépendants), à raffiner si jugé contre-intuitif à l'usage.

## 14. Ordre de construction recommandé

1. Backend core + Postgres/Prisma : modèle de données, config, QR/session, Socket.io de base.
2. App mobile : scan QR → pseudo → liste des tables → messagerie (sans appel).
3. Intégration Agora/Twilio + flux d'appel complet (mobile + backend).
4. Back-office web (supervision, libération de table, historique).
5. Notifications push FCM (peut être développé en parallèle de 2/3 dès que les événements temps réel existent).
