from pathlib import Path

def replace(path, old, new):
    p=Path(path); s=p.read_text(encoding='utf-8')
    if s.count(old)!=1: raise RuntimeError(f"{path}: expected one anchor, got {s.count(old)}")
    p.write_text(s.replace(old,new), encoding='utf-8', newline='\n')

replace('tests/e2e/poms/searchToolbar.js',
"    this.control = this.form.locator('.search-field-control');",
"    this.control = page.locator(\`\${this.formSelector} .search-field-control\`);")
replace('tests/e2e/actions/trackModalActions.js',
"""    const coverPlaceholderVisible = await this.trackModal.coverPlaceholder.isVisible()
      && await this.trackModal.coverPlaceholder.getAttribute('data-album-artbox-state') === 'empty';""",
"""    const coverPlaceholderVisible = (
      await this.trackModal.coverPlaceholder.isVisible()
      && await this.trackModal.coverPlaceholder.getAttribute('data-album-artbox-state') === 'empty'
    ) || await this.trackModal.missingArtbox.isVisible();""")
replace('music_app/services/listen_history.py',
"""    return _listen_history_adapter(config).load_pending_entries(limit=limit, eligible=eligible)""",
"""    adapter = _listen_history_adapter(config)
    if eligible is None:
        return adapter.load_pending_entries(limit=limit)
    return adapter.load_pending_entries(limit=limit, eligible=eligible)""")
