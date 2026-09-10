/* Fixed product palettes from the owner-approved Appearance v006 artifact. */
(function (scope) {
  'use strict';
  const definitions = [
  {
    "id": "steelblue",
    "name": "Steel Blue",
    "desc": "Muted blue · calm, medium-depth surfaces",
    "main": "#2D455D",
    "mode": "dark",
    "tokens": {
      "ink": "#EFF4FA",
      "muted": "#B9CADD",
      "card": "#23394D",
      "control": "#263D52",
      "line": "#596F84",
      "hover": "#FFFFFF10",
      "accent": "#8BAED1",
      "player": "#14283B",
      "player-ink": "#B9CADD",
      "play": "#9ABBDC",
      "play-ink": "#10273C",
      "stars": "#CEB97B"
    },
    "panels": [
      [
        "Deep steel",
        "#1D3247",
        "A deeper blue frame"
      ],
      [
        "Blue charcoal",
        "#263644",
        "A quieter, more neutral companion"
      ],
      [
        "Storm",
        "#344B61",
        "Gently lifted blue panels"
      ]
    ]
  },
  {
    "id": "navy",
    "name": "Deep Navy",
    "desc": "Rich navy · close to black, distinctly blue",
    "main": "#10233F",
    "mode": "dark",
    "tokens": {
      "ink": "#EFF4FA",
      "muted": "#B9CADD",
      "card": "#192E49",
      "control": "#203752",
      "line": "#526984",
      "hover": "#FFFFFF10",
      "accent": "#91B4E3",
      "player": "#09172C",
      "player-ink": "#B9CADD",
      "play": "#A0BCE6",
      "play-ink": "#10273C",
      "stars": "#CEB97B"
    },
    "panels": [
      [
        "Night blue",
        "#09182C",
        "An almost-black navy frame"
      ],
      [
        "Admiral",
        "#1B304B",
        "Lifted navy panels"
      ],
      [
        "Blue graphite",
        "#252F3C",
        "A neutral blue-gray companion"
      ]
    ]
  },
  {
    "id": "powderblue",
    "name": "Powder Blue",
    "desc": "Soft blue · airy surfaces with dark blue text",
    "main": "#DCEAF5",
    "mode": "light",
    "tokens": {
      "ink": "#21364B",
      "muted": "#435A70",
      "card": "#F7FAFD",
      "control": "#EDF4FA",
      "line": "#A1B7CC",
      "hover": "#163D620D",
      "accent": "#4F7398",
      "player": "#CBDEED",
      "player-ink": "#395571",
      "play": "#456B90",
      "play-ink": "#FFFFFF",
      "stars": "#806019"
    },
    "panels": [
      [
        "Porcelain",
        "#F5F9FD",
        "Near-white panels with a blue undertone"
      ],
      [
        "Blue mist",
        "#C5DAEB",
        "A deeper powder-blue frame"
      ],
      [
        "Frost",
        "#E7F0F8",
        "A close, gentle tonal pairing"
      ]
    ]
  },
  {
    "id": "graphite",
    "name": "Graphite",
    "desc": "Clean, neutral charcoal",
    "main": "#24272D",
    "chip": "#717780",
    "panels": [
      [
        "Charcoal",
        "#171A20",
        "A deeper matching shade"
      ],
      [
        "Cool gray",
        "#2C3038",
        "A soft neutral companion"
      ],
      [
        "Eucalyptus",
        "#233132",
        "A subtle green-blue tint"
      ]
    ]
  },
  {
    "id": "slate",
    "name": "Slate",
    "desc": "Soft blue-gray",
    "main": "#263342",
    "chip": "#70869D",
    "panels": [
      [
        "Deep slate",
        "#192635",
        "A deeper matching shade"
      ],
      [
        "Graphite",
        "#2B2D33",
        "A soft neutral companion"
      ],
      [
        "Muted teal",
        "#203839",
        "A subtle neighboring hue"
      ]
    ]
  },
  {
    "id": "midnight",
    "name": "Midnight",
    "desc": "Quiet, inky blue",
    "main": "#202B45",
    "chip": "#7384AE",
    "panels": [
      [
        "Ink",
        "#151E33",
        "A deeper matching shade"
      ],
      [
        "Smoke",
        "#292C36",
        "A soft neutral companion"
      ],
      [
        "Blue spruce",
        "#21373A",
        "A subtle neighboring hue"
      ]
    ]
  },
  {
    "id": "black",
    "name": "Solid Black",
    "desc": "Spotify-inspired · true black, soft-black panels",
    "main": "#000000",
    "mode": "dark",
    "tokens": {
      "ink": "#EEEEEE",
      "muted": "#AAAAAA",
      "card": "#181818",
      "control": "#232323",
      "line": "#454545",
      "hover": "#FFFFFF12",
      "accent": "#1DB954",
      "player": "#050505",
      "player-ink": "#BDBDBD",
      "play": "#1DB954",
      "play-ink": "#051D0C",
      "stars": "#C9B16D"
    },
    "panels": [
      [
        "Soft black",
        "#121212",
        "Subtle separation from true black"
      ],
      [
        "Carbon",
        "#1C1C1C",
        "A little more panel definition"
      ],
      [
        "Pure black",
        "#000000",
        "Black throughout, with fine borders"
      ]
    ]
  },
  {
    "id": "blackgray",
    "name": "Black & Gray",
    "desc": "Codex-inspired · neutral grays, no color cast",
    "main": "#181818",
    "mode": "dark",
    "tokens": {
      "ink": "#EEEEEE",
      "muted": "#AAAAAA",
      "card": "#202020",
      "control": "#262626",
      "line": "#454545",
      "hover": "#FFFFFF12",
      "accent": "#BDBDBD",
      "player": "#101010",
      "player-ink": "#BDBDBD",
      "play": "#D5D5D5",
      "play-ink": "#171717",
      "stars": "#C9B16D"
    },
    "panels": [
      [
        "Near black",
        "#0C0C0C",
        "A darker frame around the content"
      ],
      [
        "Graphite gray",
        "#242424",
        "Gently lifted neutral panels"
      ],
      [
        "Medium charcoal",
        "#303030",
        "More separation between surfaces"
      ]
    ]
  },
  {
    "id": "paper",
    "name": "Paper",
    "desc": "Clean white · soft-gray panels",
    "main": "#FFFFFF",
    "mode": "light",
    "tokens": {
      "ink": "#202124",
      "muted": "#505762",
      "card": "#FFFFFF",
      "control": "#F4F5F6",
      "line": "#B8BDC5",
      "hover": "#0000000B",
      "accent": "#596775",
      "player": "#E8EBEE",
      "player-ink": "#485361",
      "play": "#394551",
      "play-ink": "#FFFFFF",
      "stars": "#866519"
    },
    "panels": [
      [
        "Soft gray",
        "#F0F0F0",
        "A quiet gray frame around white"
      ],
      [
        "Pearl",
        "#E6E6E6",
        "More panel definition"
      ],
      [
        "White",
        "#FFFFFF",
        "White throughout, with fine borders"
      ]
    ]
  },
  {
    "id": "silver",
    "name": "Silver",
    "desc": "Light gray · crisp white panels",
    "main": "#E7E9EC",
    "mode": "light",
    "tokens": {
      "ink": "#202124",
      "muted": "#505762",
      "card": "#FFFFFF",
      "control": "#ECEFF2",
      "line": "#B8BDC5",
      "hover": "#0000000B",
      "accent": "#596775",
      "player": "#DDE1E5",
      "player-ink": "#485361",
      "play": "#394551",
      "play-ink": "#FFFFFF",
      "stars": "#866519"
    },
    "panels": [
      [
        "White",
        "#FFFFFF",
        "Bright panels on a soft-gray canvas"
      ],
      [
        "Mist",
        "#F4F5F7",
        "A gentler contrast"
      ],
      [
        "Silver gray",
        "#D3D7DD",
        "A deeper neutral frame"
      ]
    ]
  },
  {
    "id": "coollight",
    "name": "Cool Light",
    "desc": "Cool off-white · subtle blue-gray panels",
    "main": "#F1F5F9",
    "mode": "light",
    "tokens": {
      "ink": "#202124",
      "muted": "#4B596A",
      "card": "#FFFFFF",
      "control": "#EAF0F6",
      "line": "#AFBDCA",
      "hover": "#0000000B",
      "accent": "#526E8B",
      "player": "#DFE8F0",
      "player-ink": "#475A6D",
      "play": "#506B86",
      "play-ink": "#FFFFFF",
      "stars": "#866519"
    },
    "panels": [
      [
        "Cloud",
        "#DFE7EF",
        "A subtle blue-gray frame"
      ],
      [
        "White",
        "#FFFFFF",
        "Bright, clean panels"
      ],
      [
        "Pale slate",
        "#E9EFF5",
        "A softer tonal pairing"
      ]
    ]
  }
];
  const playerDefaults = {
    graphite: { player: '#14171C', 'player-ink': '#B9C2CD', play: '#BEC8D4', 'play-ink': '#14171C', 'player-accent': '#A9B8CA' },
    slate: { player: '#152334', 'player-ink': '#B4C9DF', play: '#A1BFDE', 'play-ink': '#152334', 'player-accent': '#8FB1D4' },
    midnight: { player: '#131C31', 'player-ink': '#BDCBE4', play: '#B0C2E8', 'play-ink': '#131C31', 'player-accent': '#A0B6DE' },
  };
  const selectionAccents = {
    steelblue: '#8BAED1',
    navy: '#91B4E3',
    powderblue: '#4F7398',
    graphite: '#8A96A3',
    slate: '#7896B4',
    midnight: '#8297CC',
    black: '#1DB954',
    blackgray: '#BDBDBD',
    paper: '#596775',
    silver: '#596775',
    coollight: '#526E8B',
  };
  const baseTokens = { ink: '#EDF0F4', muted: '#ABB6C5', card: '#202938', control: '#202938', line: '#526173', hover: '#FFFFFF0B', accent: '#68B6B0', player: '#112820', 'player-ink': '#B3CFC0', play: '#79B390', 'play-ink': '#0A2118', stars: '#D6BC6D' };
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  const palettes = freeze(definitions.map(palette => ({
    ...palette,
    mode: palette.mode || 'dark',
    selectionAccent: selectionAccents[palette.id],
    tokens: { ...(palette.tokens || {}), ...(playerDefaults[palette.id] || {}) },
  })));
  function hex(value) {
    if (typeof value !== 'string' || value.length !== 7 || !/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError('Enter a color as #RRGGBB.');
    return value.toUpperCase();
  }
  function normalizePlayerOverride(value) {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Player colors are incomplete.');
    const keys = Object.keys(value);
    if (keys.length === 3 && ['background', 'fill', 'edge'].every(key => Object.hasOwn(value, key))) {
      return { background: hex(value.background), fill: hex(value.fill), edge: hex(value.edge) };
    }
    if (!['surface', 'controls', 'waveform', 'handles'].every(key => Object.hasOwn(value, key)) || keys.some(key => !['surface', 'controls', 'waveform', 'handles', 'native_components'].includes(key))) throw new TypeError('Player colors are incomplete.');
    if (Object.hasOwn(value, 'native_components') && (!Array.isArray(value.native_components) || value.native_components.length > 4 || new Set(value.native_components).size !== value.native_components.length || value.native_components.some(part => !['surface', 'controls', 'waveform', 'handles'].includes(part)))) throw new TypeError('Invalid native player components.');
    const { surface, controls, waveform, handles } = value;
    if (!surface || !controls || !waveform || !handles || [surface, controls, waveform, handles].some(part => typeof part !== 'object' || Array.isArray(part))) throw new TypeError('Player colors are incomplete.');
    if (!['gradient', 'layered_gradient', 'solid'].includes(surface.mode) || !Number.isFinite(surface.angle) || surface.angle < 0 || surface.angle > 360) throw new TypeError('Player surface is invalid.');
    if (Object.keys(surface).length !== 4 || Object.keys(controls).length !== 2 || Object.keys(waveform).length !== 2 || Object.keys(handles).length !== 1) throw new TypeError('Player colors are incomplete.');
    return {
      surface: { mode: surface.mode, angle: surface.angle, start: hex(surface.start), end: hex(surface.end) },
      controls: { fill: hex(controls.fill), border: hex(controls.border) },
      waveform: { fill: hex(waveform.fill), edge: hex(waveform.edge) },
      handles: { color: hex(handles.color) },
      ...(Object.hasOwn(value, 'native_components') ? { native_components: [...value.native_components] } : {}),
    };
  }
  function contrastingInk(background) {
    const channels = [1, 3, 5].map(offset => parseInt(background.slice(offset, offset + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luma = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    return 1.05 / (luma + 0.05) > (luma + 0.05) / 0.05 ? '#FFFFFF' : '#000000';
  }
  function resolveAppearance(value = {}) {
    const id = value.palette_id ?? null, index = value.panel_index ?? 0;
    const palette = id === null ? null : palettes.find(item => item.id === id);
    if (id !== null && !palette) throw new TypeError('Unknown palette.');
    if (!Number.isInteger(index) || index < 0 || index > (palette ? 2 : 0)) throw new TypeError('Unknown panel companion.');
    const source = palette?.tokens || {};
    const override = normalizePlayerOverride(value.player_override ?? null);
    const player = override && Object.hasOwn(override, 'surface') ? {
      background: override.surface.start,
      fill: override.waveform.fill,
      edge: override.waveform.edge,
      style: override,
    } : override || {
      background: source.player || '#112820',
      fill: source['waveform-fill'] || source['player-accent'] || source.accent || '#79B390',
      edge: source['waveform-edge'] || source['player-ink'] || '#DCEBE3',
    };
    const tokens = { ...baseTokens, ...source, 'waveform-fill': player.fill, 'waveform-edge': player.edge,
      'player-surface-start': player.background, 'player-surface-end': player.background,
      'player-surface-angle': '0deg', 'player-control-border': player.edge, 'player-handle': player.edge };
    if (override) {
      const style = player.style;
      const controlFill = style?.controls.fill || contrastingInk(player.background);
      Object.assign(tokens, {
        player: player.background,
        'player-surface-start': style?.surface.start || player.background,
        'player-surface-end': (style?.surface.mode === 'solid' ? style.surface.start : style?.surface.end) || player.background,
        'player-surface-angle': style ? `${style.surface.angle}deg` : '0deg',
        'player-ink': contrastingInk(player.background),
        play: controlFill,
        'play-ink': contrastingInk(controlFill),
        'player-control-border': style?.controls.border || player.edge,
        'player-accent': player.fill,
        'player-handle': style?.handles.color || player.edge,
      });
    }
    return { main: palette?.main || (value.main_surface_color == null ? '#111C2C' : hex(value.main_surface_color)),
      panel: palette ? palette.panels[index][1] : (value.panel_background_color == null ? '#0E1B2B' : hex(value.panel_background_color)),
      tokens, player: { ...player }, mode: palette?.mode || 'dark' };
  }
  // Representative editor colors for native CSS treatments. Only explicit
  // native_components provenance retains gradients, alpha and local waveform colors.
  const nativePlayerStyle = Object.freeze({
    surface: Object.freeze({ mode: 'layered_gradient', angle: 135, start: '#061816', end: '#0F172A' }),
    controls: Object.freeze({ fill: '#0FA66F', border: '#7CBAA4' }),
    waveform: Object.freeze({ fill: '#DADDE2', edge: '#494950' }),
    handles: Object.freeze({ color: '#BBF7D0' }),
  });
  function nativePlayerComponents(value) {
    const style = value.player_style_override;
    if (!style?.surface) return {};
    return Object.fromEntries((style.native_components || []).map(component => [component, true]));
  }
  const api = { palettes, resolveAppearance, normalizePlayerOverride, contrastingInk, nativePlayerStyle, nativePlayerComponents };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope) scope.AlbumHavenAppearancePalettes = api;
})(typeof window !== 'undefined' ? window : null);
