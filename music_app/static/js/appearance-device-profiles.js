(function () {
  'use strict';

  const profiles = ['web_desktop', 'mobile', 'tv'];
  const sections = ['main', 'player', 'interaction', 'alerts', 'album'];
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const profileValues = (profile, section, values = {}) => {
    const result = copy(values);
    if (profile !== 'web_desktop' && section === 'player') delete result.loop_control_style;
    return result;
  };

  function normalizeMode(value, baseValues = {}, profile, section) {
    const mode = value?.mode === 'custom' ? 'custom' : 'follow';
    const customValues = value?.values && typeof value.values === 'object' && !Array.isArray(value.values)
      ? profileValues(profile, section, value.values)
      : (mode === 'custom' ? profileValues(profile, section, baseValues) : {});
    return { mode, values: customValues };
  }

  function normalizeAppearanceDeviceProfiles(value, baseSections = {}) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(profiles.map((profile) => [profile, {
      sections: Object.fromEntries(sections.map((section) => [section,
        profile === 'web_desktop'
          ? { mode: 'custom', values: copy(baseSections[section] || {}) }
          : normalizeMode(source[profile]?.sections?.[section], baseSections[section] || {}, profile, section),
      ])),
    }]));
  }

  function resolveAppearanceDeviceSection(profileSet, profile, section) {
    const base = profileSet?.web_desktop?.sections?.[section]?.values || {};
    if (profile === 'web_desktop') return copy(base);
    const candidate = profileSet?.[profile]?.sections?.[section];
    return copy(candidate?.mode === 'custom'
      ? { ...base, ...profileValues(profile, section, candidate.values) }
      : base);
  }

  function setAppearanceDeviceSectionMode(profileSet, profile, section, mode) {
    if (!['mobile', 'tv'].includes(profile) || !sections.includes(section)) return profileSet;
    const next = copy(profileSet);
    const candidate = next[profile].sections[section];
    if (mode === 'custom' && candidate.mode !== 'custom' && !Object.keys(candidate.values || {}).length) {
      candidate.values = profileValues(
        profile,
        section,
        resolveAppearanceDeviceSection(next, 'web_desktop', section),
      );
    }
    candidate.mode = mode === 'custom' ? 'custom' : 'follow';
    return next;
  }

  window.AlbumHavenAppearanceProfiles = Object.freeze({
    profiles: Object.freeze([...profiles]),
    sections: Object.freeze([...sections]),
    normalize: normalizeAppearanceDeviceProfiles,
    resolveSection: resolveAppearanceDeviceSection,
    setMode: setAppearanceDeviceSectionMode,
  });
})();
