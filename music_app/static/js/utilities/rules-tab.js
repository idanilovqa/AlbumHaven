function renderUtilityRules() {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.list || !els.detail || !els.count) return;
  const rules = state.utility.rules || [];
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'Rules';
  els.count.textContent = String(rules.length);
  setUtilitySearchState({ enabled: false, placeholder: 'Rules', value: '' });
  setUtilityProblemFilterState({ enabled: false, hidden: true, chipsHtml: '' });

  if (state.utility.rulesLoading) {
    els.list.innerHTML = '<div class="utility-empty-state compact">Loading rules...</div>';
    els.detail.innerHTML = '<div class="utility-empty-state">Loading rules...</div>';
    return;
  }

  if (!rules.length) {
    els.list.innerHTML = '<div class="utility-empty-state compact">No rules found.</div>';
    els.detail.innerHTML = '<div class="utility-empty-state">No rules found.</div>';
    return;
  }

  if (!state.utility.selectedRuleKey || !rules.some((item) => item.key === state.utility.selectedRuleKey)) {
    state.utility.selectedRuleKey = rules[0].key || '';
  }
  const selectedRule = getSelectedUtilityRule();
  els.list.innerHTML = rules.map((rule) => buildUtilityRuleListItem(rule, rule.key === state.utility.selectedRuleKey)).join('');
  els.detail.innerHTML = buildUtilityRuleDetail(selectedRule);
}

async function loadUtilityRules(force = false) {
  if (state.utility.rulesLoading) return state.utility.rulesLoadPromise;
  if (state.utility.rulesLoaded && !force) {
    renderUtilityModalContent();
    return null;
  }
  state.utility.rulesLoading = true;
  renderUtilityModalContent();
  state.utility.rulesLoadPromise = (async () => {
    try {
      const response = await fetch('/utilities/rules', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      state.utility.rules = Array.isArray(data.rules) ? data.rules : [];
      if (Array.isArray(data.ignored_version_keys)) {
        state.view.ignored_version_keys = data.ignored_version_keys;
      }
      state.utility.rulesLoaded = true;
    } catch (error) {
      console.error('[AlbumHaven][Utilities] Failed to load rules.', error);
      state.utility.rules = [];
      showToast('Unable to load utility rules.', 'error', 3200);
    } finally {
      state.utility.rulesLoading = false;
      state.utility.rulesLoadPromise = null;
      renderUtilityModalContent();
    }
  })();
  return state.utility.rulesLoadPromise;
}

function handleRulesUtilityClick(event) {
  const utilityRuleButton = event.target.closest('[data-utility-rule-key]');
  if (utilityRuleButton) {
    event.preventDefault();
    state.utility.selectedRuleKey = utilityRuleButton.getAttribute('data-utility-rule-key') || '';
    renderUtilityModalContent();
    return true;
  }

  const revertVersionExceptionButton = event.target.closest('[data-revert-version-exception]');
  if (revertVersionExceptionButton) {
    event.preventDefault();
    revertVersionException(revertVersionExceptionButton.getAttribute('data-revert-version-exception') || '');
    return true;
  }

  const revertProblemIgnoreButton = event.target.closest('[data-revert-problem-ignore]');
  if (revertProblemIgnoreButton) {
    event.preventDefault();
    revertProblemIgnore(revertProblemIgnoreButton.getAttribute('data-revert-problem-ignore') || '');
    return true;
  }

  return false;
}

registerUtilityTab('rules', {
  render: renderUtilityRules,
  load: loadUtilityRules,
  shouldLoadOnActivate() {
    return !state.utility.rulesLoaded;
  },
  handleClick: handleRulesUtilityClick,
});
