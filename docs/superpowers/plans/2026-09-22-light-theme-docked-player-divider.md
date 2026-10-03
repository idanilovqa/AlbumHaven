# Light-theme docked-player divider implementation plan

1. Extend the docked-player component fixture with an appearance mode and theme ink token.
2. Add a failing assertion that checked regular styling uses theme ink in light mode.
3. Add the narrow light-theme CSS override after the existing customized-player divider rule.
4. Run the focused docked-player component cases and `git diff --check`.
5. Reload localhost:5001 and inspect the checked docked player's computed divider color.
