// Independent acceptance catalog: expected recipient UI, never derived from the app's policy payload.
export const CAPABILITY_LABELS = {
  view: 'View library', play: 'Play music', edit: 'Edit audio tags', covers: 'Change covers',
  delete: 'Delete covers and missing inventory', admin: 'Administer users and access',
  create: 'Create loops', practice: 'Practice with loops', repair: 'Repair files, rules and logs',
};

export const ROLE_PROFILES = [
  { name: 'Viewer', roles: ['Viewer'], visible: [] },
  { name: 'Listener', roles: ['Listener'], visible: ['play'] },
  { name: 'Musician', roles: ['Musician'], visible: ['play', 'create', 'savedCreate', 'practice'] },
  { name: 'Owner', roles: ['Owner'], visible: ['play', 'covers', 'delete', 'create', 'savedCreate', 'practice', 'repair', 'scan', 'integrations', 'folder', 'loopManagement'] },
  { name: 'Admin', roles: ['Admin'], visible: ['admin'] },
];
export const CAPABILITY_PROFILES = [
  { name: 'View', capabilities: ['view'], visible: [] },
  { name: 'Play', capabilities: ['play'], visible: ['play'] },
  { name: 'Edit on web without Admin', capabilities: ['edit'], visible: ['play'] },
  { name: 'Change covers', capabilities: ['covers'], visible: ['covers'] },
  { name: 'Delete', capabilities: ['delete'], visible: ['play', 'delete'] },
  { name: 'Admin without View', capabilities: ['admin'], visible: ['admin'], noView: true },
  // Create has no playable source on its own.
  { name: 'Create loops without Play or Practice', capabilities: ['create'], visible: [] },
  { name: 'Practice', capabilities: ['practice'], visible: ['practice'] },
  { name: 'Repair', capabilities: ['repair'], visible: ['repair'] },
];
export const UNION_PROFILES = [
  { name: 'Edit plus Admin', capabilities: ['edit', 'admin'], visible: ['play', 'edit', 'admin'] },
  { name: 'Play plus Create', capabilities: ['play', 'create'], visible: ['play', 'create'] },
  { name: 'Practice plus Create', capabilities: ['practice', 'create'], visible: ['practice', 'savedCreate'] },
  { name: 'Change covers plus Delete', capabilities: ['covers', 'delete'], visible: ['play', 'covers', 'delete'] },
  { name: 'Owner plus Admin', roles: ['Owner', 'Admin'], visible: ['play', 'covers', 'delete', 'edit', 'admin', 'create', 'savedCreate', 'practice', 'repair', 'scan', 'integrations', 'folder', 'loopManagement'] },
];
export const CLIENT_PROFILES = [
  { name: 'mobile', roles: ['Owner', 'Admin'],
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    visible: ['play', 'covers', 'admin', 'practice', 'repair', 'scan', 'integrations', 'folder'] },
  { name: 'TV', roles: ['Owner', 'Admin'],
    userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 8.0) AppleWebKit/537.36 TV Safari/537.36',
    visible: ['play', 'covers', 'repair', 'scan', 'integrations', 'folder'], providerOnly: true },
];
