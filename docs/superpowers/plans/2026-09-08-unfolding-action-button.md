# UnfoldingActionButton implementation plan

Approved design: extend ActionButton with multiple actions, expansion and collapse, animation, reduced motion, and keyboard focus. Gallery supplies choices and its selection callback.

- Add an independently reusable renderer and controller beside ButtonComponent.
- Put expansion and interaction styling in the shared component stylesheet.
- Replace Gallery expansion, dismissal, and focus handling with component calls.
- Verify multiple choices, selection, Escape, outside dismissal, keyboard navigation, and Gallery contracts.

Implementation: shared JS renderer/controller and stylesheet loaded alongside ButtonComponent. Existing server-rendered Gallery actions adopt the shared classes before JavaScript mounts them. Gallery retains only its action values and selection callback.

Focused verification: 40 JavaScript checks passed. Browser/manual acceptance remains pending.
