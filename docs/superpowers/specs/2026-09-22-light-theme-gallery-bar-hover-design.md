# Light-theme Gallery-bar hover design

## Outcome

Gallery-bar action buttons use a brighter hover surface in light themes. The hover remains understated and follows the active theme instead of adding a fixed white or green fill.

## Scope

- Apply the change only to Gallery-bar action controls, including the view-choice cluster.
- Apply it only when `data-appearance-mode='light'` is active.
- Derive the hover background from `--gallery-toolbar-button-background`, with its existing Gallery surface fallback, by mixing in 15% white.
- Keep the current border, green hover icon, focus, pressed, disabled, and open-anchor treatments.
- Keep dark-theme behavior unchanged.
- Preserve custom palette colors by using the resolved Gallery button surface as the mix source.

## Implementation boundary

Add a light-mode override in `music_app/static/css/gallery-main.css` beside the existing Gallery action hover rules. Do not change shared button hover tokens in `appearance-backgrounds.css`; other screens must retain their current behavior.

## Verification

Add a focused component assertion that compares computed hover backgrounds in light and dark modes:

- light mode resolves to an 85% Gallery surface and 15% white mix;
- the green icon and existing border treatment remain intact;
- dark mode continues to use the existing hover token.

Run the focused Gallery component test and its complete component spec.
