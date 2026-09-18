from pathlib import Path
cases = {
'tests/e2e/specs/appearanceControls.spec.js': [('FTC-SETTINGS-A01 shared search preserves the staged loop style and Save hydrates it before Settings opens','@area:settings')],
'tests/e2e/specs/settingsRefactorShell.spec.js': [
('FTC-SETTINGS-S01 six tabs preserve keyboard wrapping and joined Close hit testing','@area:settings'),
('FTC-SETTINGS-S02 combined search and Filters retain selection and keyboard anchor focus','@area:settings'),
('FTC-SETTINGS-S03 deep Problems selection retains the mounted tree scroll and focused row','@area:settings'),
('FTC-SETTINGS-S04 ready and missing Problems artwork preserve selection through the real lightbox lifecycle','@area:settings'),
('FTC-SETTINGS-S05 an open Filters surface remains inside Settings after narrow resize and reopen','@area:settings')],
'tests/e2e/specs/settingsIntegrations.functional.spec.js': [
('FTC-SETTINGS-I01 real folder picking preserves Cancel and validates saved root membership','@area:integrations'),
('FTC-SETTINGS-I02 Scrobbling statistics and readable Foobar help retain disabled playlist import','@area:integrations')],
'tests/e2e/specs/loops.functional.spec.js': [
('FTC-SETTINGS-H03 real log download matches the displayed captured snapshot','@area:log-history'),
('FTC-SETTINGS-L02 native panel drag persists order while another loop retains playback and its pending range','@area:loops')],
}
for path, entries in cases.items():
    p=Path(path); s=p.read_text(encoding='utf-8')
    for title, tag in entries:
        old=f"test('{title}', async ({{"
        new=f"test('{title}', {{ tag: '{tag}' }}, async ({{"
        if s.count(old)!=1: raise RuntimeError(f'{path}: {title}: anchor count {s.count(old)}')
        s=s.replace(old,new)
    p.write_text(s,encoding='utf-8',newline='\n')
