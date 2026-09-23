# Player Preview Sticky Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep only the preview player sticky while the Seekbar style control scrolls with the Player & Seekbar settings.

**Architecture:** Preserve the existing sticky `.player-preview-dock` and move `.player-seekbar-mode` outside it in generated markup. Extend the existing source-level layout contract with a small ancestor reader so the test verifies DOM ownership in Default and Waveform modes.

**Tech Stack:** JavaScript, Node.js built-in test runner, HTML strings, CSS.

## Global Constraints

- Apply the behavior to Default seekbar and Waveform seekbar modes.
- Keep preferences, event handling, styling tokens, permissions, deployment modes, client support, and persistence unchanged.
- Keep `.player-preview-dock` sticky at `top: 0`.

---

### Task 1: Correct the sticky ownership boundary

**Files:**
- Modify: `tests/js/runtime/appearance-workspace.test.js:155`
- Modify: `music_app/static/js/appearance-backgrounds.js:638`

**Interfaces:**
- Consumes: `seekbarMarkup(seekbarMode)` returns the Player & Seekbar editor markup.
- Produces: markup where `.player-seekbar-mode` is a sibling after `.player-preview-dock` and before `.player-editor-workspace`.

- [ ] **Step 1: Write the failing test**

Add this helper near the existing test helpers:

```js
function openElementClassesAt(markup, offset) {
  const stack = [];
  const tags = /<\/?([a-z][\w-]*)(?:\s[^>]*)?>/gi;
  let match;
  while ((match = tags.exec(markup)) && match.index < offset) {
    if (match[0].startsWith('</')) {
      stack.pop();
      continue;
    }
    if (match[0].endsWith('/>')) continue;
    stack.push(match[0].match(/\bclass="([^"]*)"/)?.[1] || '');
  }
  return stack;
}
```

Replace the Player & Seekbar assertions in `Main elements and Player & Seekbar keep their live previews visible while settings scroll` with:

```js
for (const mode of ['default', 'waveform']) {
  const player = appearance.seekbarMarkup(mode);
  const seekbarModeOffset = player.indexOf('<section class="player-seekbar-mode"');
  const openClasses = openElementClassesAt(player, seekbarModeOffset);

  assert.ok(seekbarModeOffset > 0);
  assert.ok(player.indexOf('data-player-live-preview') < seekbarModeOffset);
  assert.ok(seekbarModeOffset < player.indexOf('<div class="player-editor-workspace"'));
  assert.ok(!openClasses.includes('player-preview-dock'), `${mode} selector must scroll outside the sticky preview`);
  assert.equal((player.match(/class="player-seekbar-mode"/g) || []).length, 1);
}
assert.match(css, /\.player-preview-dock\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-name-pattern="live previews visible while settings scroll" tests/js/runtime/appearance-workspace.test.js
```

Expected: FAIL for both modes because `openClasses` contains `player-preview-dock` at the Seekbar style section.

- [ ] **Step 3: Apply the minimal markup fix**

In `seekbarMarkup()`, close `.player-preview-dock` after `.player-live-preview`, then keep the selector before the workspace:

```js
        </div>
      </div>
      <section class="player-seekbar-mode" aria-labelledby="appearance-seekbar-style-label"><h4 id="appearance-seekbar-style-label">Seekbar style</h4><p class="background-help">Choose the player seekbar style. Display mode applies immediately in this browser.</p><div class="appearance-section player-seekbar-options"><label class="appearance-option"><input type="radio" name="seekbar-mode" value="default" ${waveformSelected ? '' : 'checked'} data-appearance-seekbar-mode="default"><span>Default seekbar</span></label><label class="appearance-option"><input type="radio" name="seekbar-mode" value="waveform" ${waveformSelected ? 'checked' : ''} data-appearance-seekbar-mode="waveform"><span>Waveform seekbar</span></label></div></section>
      <div class="player-editor-workspace">
```

- [ ] **Step 4: Verify GREEN and related contracts**

Run:

```powershell
& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 tests/js/runtime/appearance-workspace.test.js tests/js/runtime/appearance-v009-player-isolation.test.js
```

Expected: both files pass without errors or warnings.

- [ ] **Step 5: Verify the rendered scroll behavior**

Open Appearance, select Player & Seekbar, and test Default and Waveform modes. Scroll past Seekbar style and confirm its box leaves the viewport while the preview player stays at the top through the remaining settings.

- [ ] **Step 6: Commit**

```powershell
git add -- tests/js/runtime/appearance-workspace.test.js music_app/static/js/appearance-backgrounds.js docs/superpowers/plans/2026-09-05-player-preview-sticky-boundary.md
git commit -m "fix: keep only player preview sticky"
```
