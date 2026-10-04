import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RestaurantConfigService } from './restaurant-config.service';

describe('RestaurantConfigService', () => {
  function writeTempConfig(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restotalk-config-'));
    const filePath = path.join(dir, 'restaurant.yaml');
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  it('loads a valid config file', () => {
    const filePath = writeTempConfig(`
restaurant:
  name: "Le Bistrot"
  tableCount: 20
  sessionInactivityTimeoutHours: 4
`);

    const service = new RestaurantConfigService(filePath);

    expect(service.get()).toEqual({
      name: 'Le Bistrot',
      tableCount: 20,
      sessionInactivityTimeoutHours: 4,
    });
  });

  it('throws a descriptive error when tableCount is missing', () => {
    const filePath = writeTempConfig(`
restaurant:
  name: "Le Bistrot"
  sessionInactivityTimeoutHours: 4
`);

    expect(() => new RestaurantConfigService(filePath)).toThrow(/tableCount/);
  });

  it('throws when the file does not exist', () => {
    expect(() => new RestaurantConfigService('/no/such/file.yaml')).toThrow();
  });
});
