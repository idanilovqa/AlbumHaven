const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..', '..');
const componentPath = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'playback-control-cluster.js');
const macroPath = path.join(repoRoot, 'music_app', 'templates', 'partials', 'playback-control-cluster.html');
const templatePath = path.join(repoRoot, 'music_app', 'templates', 'index.html');
const utilityBuilderPath = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'utility-list-builders.js');
const compactControllerPath = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'compact-player-controller.js');

function loadComponent() {
  assert.equal(fs.existsSync(componentPath), true, 'PlaybackControlCluster JavaScript renderer must exist');
  delete require.cache[require.resolve(componentPath)];
  global.buildLoopEditActionControl = options => `<span data-rendered-loop-owner="${options.ownerId}"></span>`;
  return require(componentPath);
}

test.afterEach(() => {
  delete global.buildLoopEditActionControl;
});

test('JavaScript renderer owns each playback-control variant and rejects unknown variants', () => {
  const component = loadComponent();

  const expanded = component.renderPlaybackControlCluster({ variant: 'expanded-player', ownerId: 'global-player' });
  assert.match(expanded, /data-playback-control-cluster/);
  assert.match(expanded, /data-playback-control-variant="expanded-player"/);
  assert.match(expanded, /id="player-play"/);
  assert.match(expanded, /data-loop-action-mount="global-player"/);
  assert.doesNotMatch(expanded, /data-playback-control-action="previous"|data-playback-control-action="next"/);

  const compact = component.renderPlaybackControlCluster({ variant: 'compact-player' });
  assert.match(compact, /data-playback-control-variant="compact-player"/);
  assert.match(compact, /data-playback-control-action="previous"/);
  assert.match(compact, /data-playback-control-action="play-pause"/);
  assert.match(compact, /data-playback-control-action="next"/);
  assert.doesNotMatch(compact, /data-loop-action-mount|data-rendered-loop-owner/);

  const saved = component.renderPlaybackControlCluster({
    variant: 'saved-loop',
    ownerId: 'saved-loop-loop-1',
    loopId: 'loop-1',
  });
  assert.match(saved, /data-playback-control-variant="saved-loop"/);
  assert.match(saved, /data-loop-play="loop-1"/);
  assert.match(saved, /data-rendered-loop-owner="saved-loop-loop-1"/);
  assert.doesNotMatch(saved, /data-playback-control-action="previous"|data-playback-control-action="next"/);

  assert.throws(
    () => component.renderPlaybackControlCluster({ variant: 'invented-player' }),
    /Unknown PlaybackControlCluster variant/,
  );
});

test('component query helper returns only controls owned by the supplied root', () => {
  const component = loadComponent();
  const owned = {
    previous: { name: 'previous' },
    playPause: { name: 'play-pause' },
    next: { name: 'next' },
    loopActions: { name: 'loop-actions' },
  };
  const root = {
    querySelector(selector) {
      return {
        '[data-playback-control-action="previous"]': owned.previous,
        '[data-playback-control-action="play-pause"]': owned.playPause,
        '[data-playback-control-action="next"]': owned.next,
        '[data-playback-control-loop-actions]': owned.loopActions,
      }[selector] || null;
    },
  };

  assert.deepEqual(component.getPlaybackControlClusterElements(root), owned);
  assert.deepEqual(component.getPlaybackControlClusterElements(null), {
    previous: null,
    playPause: null,
    next: null,
    loopActions: null,
  });
});

test('Jinja macro emits the same component roots and native control hooks', () => {
  assert.equal(fs.existsSync(macroPath), true, 'PlaybackControlCluster Jinja macro must exist');
  const macro = fs.readFileSync(macroPath, 'utf8');

  assert.match(macro, /macro playback_control_cluster\(variant/);
  assert.match(macro, /data-playback-control-cluster/);
  assert.match(macro, /data-playback-control-variant="\{\{ variant \}\}"/);
  assert.match(macro, /variant == 'expanded-player'/);
  assert.match(macro, /variant == 'compact-player'/);
  assert.match(macro, /data-playback-control-action="play-pause"/);
  assert.match(macro, /data-playback-control-action="previous"/);
  assert.match(macro, /data-playback-control-action="next"/);
  assert.match(macro, /data-playback-control-loop-actions/);
  assert.match(macro, /aria-label="Previous track"/);
  assert.match(macro, /aria-label="Play or pause"/);
  assert.match(macro, /aria-label="Next track"/);
});

test('live player consumers render and query the shared component boundary', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  const utilityBuilder = fs.readFileSync(utilityBuilderPath, 'utf8');
  const compactController = fs.readFileSync(compactControllerPath, 'utf8');

  assert.match(template, /from "partials\/playback-control-cluster\.html" import playback_control_cluster/);
  assert.match(template, /playback_control_cluster\('expanded-player', owner_id='global-player'\)/);
  assert.match(template, /playback_control_cluster\('compact-player'\)/);
  assert.doesNotMatch(template, /<span class="loop-play-control-cluster player-play-cluster"/);
  assert.doesNotMatch(template, /<div class="compact-player-transport"/);

  assert.match(utilityBuilder, /renderPlaybackControlCluster\(\{\s*variant:\s*'saved-loop'/s);
  assert.doesNotMatch(utilityBuilder, /<div class="loop-play-control-cluster utility-loop-play-cluster"/);

  assert.match(compactController, /const compactControls = getPlaybackControlClusterElements\(compactControlRoot\)/);
  assert.match(compactController, /play:\s*compactControls\.playPause/);
  assert.match(compactController, /previous:\s*compactControls\.previous/);
  assert.match(compactController, /next:\s*compactControls\.next/);
  assert.doesNotMatch(compactController, /player\?\.querySelector\('\[data-compact-player-(?:play|previous|next)\]'/);
});

test('expanded player controls keep component ownership across seekbar-mode centerlines', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  const cssPath = path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  const shellRule = css.match(/(?:^|\n)\.player-shell\s*\{([^}]*)\}/s)?.[1] || '';
  const controlsRule = css.match(/\.player-controls\s*\{([^}]*)\}/s)?.[1] || '';
  const coverRule = css.match(/\.player-cover-button\s*\{([^}]*)\}/s)?.[1] || '';
  const componentRule = css.match(/\.player-play-cluster\s*\{([^}]*)\}/s)?.[1] || '';
  const mainRule = css.match(/\.player-main\s*\{([^}]*)\}/s)?.[1] || '';
  const controlsMarkup = template.match(
    /<div class="player-controls">([^]*?)<\/div>\s*<div class="player-main">/s,
  )?.[1] || '';

  assert.match(controlsMarkup, /class_name='player-collapse-button'/);
  assert.match(controlsMarkup, /class="player-cover-button"/);
  assert.match(controlsMarkup, /playback_control_cluster\('expanded-player', owner_id='global-player'\)/);
  assert.match(shellRule, /grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)/);
  assert.match(shellRule, /height:\s*100%/);
  assert.match(mainRule, /position:\s*relative/);
  assert.match(mainRule, /height:\s*100%/);
  assert.match(controlsRule, /display:\s*flex/);
  assert.match(controlsRule, /align-items:\s*center/);
  assert.match(controlsRule, /height:\s*var\(--player-controls-size\)/);
  assert.match(controlsRule, /gap:\s*8px/);
  assert.doesNotMatch(coverRule, /grid-row|align-self|margin-top/);
  assert.doesNotMatch(componentRule, /grid-row|grid-column|align-self|margin-top/);
  assert.match(css, /data-player-seekbar-presentation="waveform"[^}]*\.player-controls\s*\{[^}]*--player-waveform-centerline/s);
  assert.match(css, /data-player-seekbar-presentation="regular"[^}]*\.player-controls\s*\{[^}]*--player-regular-centerline/s);
});
