const { applyTheme } = require('../../music_app/static/js/appearance-backgrounds.js');

// Resolve production tokens without starting the account preference client.
async function applyFixtureAppearance(page, preferences) {
  const attributes = {};
  const properties = {};
  applyTheme({ main_surface_color: null, panel_background_color: null, player_override: null, ...preferences }, {
    style: {
      setProperty: (key, value) => { properties[key] = value; },
      removeProperty: key => { delete properties[key]; },
    },
    setAttribute: (key, value) => { attributes[key] = value; },
    removeAttribute: key => { delete attributes[key]; },
  });
  await page.evaluate(({ attributes, properties }) => {
    const root = document.documentElement;
    root.removeAttribute('style');
    for (const [key, value] of Object.entries(attributes)) root.setAttribute(key, value);
    for (const [key, value] of Object.entries(properties)) root.style.setProperty(key, value);
  }, { attributes, properties });
}

module.exports = { applyFixtureAppearance };
