/* Controlled placement of existing widgets; their components retain content ownership. */
const Dashboard = (() => {
  const mountedRoots = new WeakSet();

  function mount(root, options = {}) {
    if (!(root instanceof HTMLElement) || mountedRoots.has(root)
      || !Array.isArray(options.widgets) || typeof options.onSizeIntent !== 'function') {
      throw new TypeError('Dashboard requires an unowned root, widgets and onSizeIntent.');
    }
    const keys = new Set();
    const owners = new Set([root]);
    // Validate the complete input before adding any controls or attributes.
    const widgets = options.widgets.map((descriptor) => {
      if (!descriptor || typeof descriptor.key !== 'string' || !descriptor.key.trim()
        || keys.has(descriptor.key)) {
        throw new TypeError('Dashboard widget keys must be nonempty and unique.');
      }
      const { key, element, header, body, backHost = header } = descriptor;
      const nodes = [element, header, body];
      if (nodes.some(node => !(node instanceof HTMLElement) || owners.has(node))
        || new Set(nodes).size !== nodes.length || element.parentNode !== root
        || !element.contains(header) || !element.contains(body)
        || header.contains(body) || body.contains(header)
        || !(backHost instanceof HTMLElement) || backHost.ownerDocument !== root.ownerDocument
        || body.contains(backHost)) {
        throw new TypeError('Dashboard widgets require distinct existing element, header and body owners.');
      }
      keys.add(key);
      nodes.forEach(node => owners.add(node));
      return { key, element, header, body, backHost };
    });
    const onSizeIntent = options.onSizeIntent;
    const attributes = [
      [root, 'data-dashboard'],
      [root, 'data-dashboard-layout'],
      [root, 'data-dashboard-expanded-key'],
      ...widgets.map(widget => [widget.element, 'data-dashboard-widget-state']),
    ].map(([element, name]) => ({ element, name, previous: element.getAttribute(name) }));
    let expandedKey = null;
    let disposed = false;
    const controls = widgets.length > 1 ? widgets.map((widget) => {
      const holder = root.ownerDocument.createElement('div');
      holder.innerHTML = ButtonComponent.renderActionButton({
        ariaLabel: 'Full size',
        title: 'Full size',
        presentation: 'bare',
        icon: 'expand',
        iconClass: 'dashboard__size-icon',
        attributes: { 'aria-expanded': 'false', 'data-dashboard-action': 'expand' },
      });
      const button = holder.firstElementChild;
      let parent = widget.header.querySelector('.gallery-bar__actions, .album-details-header__actions');
      const ownsParent = !parent;
      if (!parent) {
        parent = root.ownerDocument.createElement('div');
        parent.className = widget.header.classList.contains('album-details-header')
          ? 'album-details-header__actions' : 'gallery-bar__actions';
        widget.header.appendChild(parent);
      }
      holder.innerHTML = ButtonComponent.renderActionButton({
        icon: 'back', ariaLabel: 'Back', title: 'Back', presentation: 'bare',
        attributes: { 'data-dashboard-action': 'back' },
      });
      const back = holder.firstElementChild;
      const onClick = (event) => {
        if (disposed || expandedKey === widget.key) return;
        event.preventDefault();
        event.stopPropagation();
        onSizeIntent(widget.key, widget.key);
      };
      const onBack = (event) => {
        if (disposed || expandedKey !== widget.key) return;
        event.preventDefault();
        event.stopPropagation();
        onSizeIntent(widget.key, null);
      };
      return { widget, button, back, parent, ownsParent, onClick, onBack };
    }) : [];

    function update(state = {}) {
      if (disposed) return;
      const nextKey = state.expandedKey;
      if (nextKey !== null && !keys.has(nextKey)) {
        throw new TypeError('Dashboard expandedKey must be null or an existing widget key.');
      }
      const previousKey = expandedKey;
      const focused = controls.some(({button, back}) => [button, back].includes(root.ownerDocument.activeElement));
      // A sole widget already occupies the full container in every controlled state.
      expandedKey = widgets.length === 1 ? null : nextKey;
      root.setAttribute('data-dashboard-layout', widgets.length === 1 ? 'single' : expandedKey === null ? 'ordinary' : 'expanded');
      if (expandedKey === null) root.removeAttribute('data-dashboard-expanded-key');
      else root.setAttribute('data-dashboard-expanded-key', expandedKey);
      widgets.forEach((widget) => {
        const state = widgets.length === 1 ? 'fill' : expandedKey === null ? 'ordinary'
          : widget.key === expandedKey ? 'expanded' : 'suppressed';
        widget.element.setAttribute('data-dashboard-widget-state', state);
      });
      controls.forEach(({ widget, button, back, parent }) => {
        const expanded = widget.key === expandedKey;
        if (expanded) {
          button.remove();
          if (back.parentNode !== widget.backHost) widget.backHost.prepend(back);
        } else {
          back.remove();
          if (button.parentNode !== parent) parent.prepend(button);
        }
      });
      if (focused && previousKey !== expandedKey) {
        const control = controls.find(({widget}) => widget.key === (expandedKey ?? previousKey));
        (expandedKey === null ? control?.button : control?.back)?.focus({preventScroll: true});
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      controls.forEach(({ button, back, parent, ownsParent, onClick, onBack }) => {
        button.removeEventListener('click', onClick);
        back.removeEventListener('click', onBack);
        button.remove(); back.remove();
        if (ownsParent) parent.remove();
      });
      attributes.forEach(({ element, name, previous }) => {
        if (previous === null) element.removeAttribute(name);
        else element.setAttribute(name, previous);
      });
      mountedRoots.delete(root);
    }

    mountedRoots.add(root);
    root.setAttribute('data-dashboard', 'true');
    controls.forEach(({ button, back, parent, onClick, onBack }) => {
      parent.prepend(button);
      button.addEventListener('click', onClick);
      back.addEventListener('click', onBack);
    });
    update({ expandedKey: null });
    return { update, dispose };
  }

  return { mount };
})();
