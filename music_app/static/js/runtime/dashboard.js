/* Controlled placement of existing widgets; their components retain content ownership. */
const Dashboard = (() => {
  const mountedRoots = new WeakSet();
  const sizePaths = {
    full: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
    widget: 'M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5',
    back: 'm10 5-7 7 7 7M3 12h18',
  };

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
      const { key, element, header, body } = descriptor;
      const nodes = [element, header, body];
      if (nodes.some(node => !(node instanceof HTMLElement) || owners.has(node))
        || new Set(nodes).size !== nodes.length || element.parentNode !== root
        || !element.contains(header) || !element.contains(body)
        || header.contains(body) || body.contains(header)) {
        throw new TypeError('Dashboard widgets require distinct existing element, header and body owners.');
      }
      keys.add(key);
      nodes.forEach(node => owners.add(node));
      return { key, element, header, body };
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
        iconClass: 'dashboard__size-icon',
        attributes: { 'aria-expanded': 'false' },
      });
      const button = holder.firstElementChild;
      button.querySelector('.dashboard__size-icon').innerHTML = `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${sizePaths.full}"/></svg>`;
      const path = button.querySelector('path');
      const parent = widget.header.querySelector('.gallery-bar__actions, .album-details-header__actions') || widget.header;
      const onClick = (event) => {
        if (disposed) return;
        event.preventDefault();
        event.stopPropagation();
        onSizeIntent(widget.key, expandedKey === widget.key ? null : widget.key);
      };
      return { widget, button, path, parent, onClick };
    }) : [];

    function update(state = {}) {
      if (disposed) return;
      const nextKey = state.expandedKey;
      if (nextKey !== null && !keys.has(nextKey)) {
        throw new TypeError('Dashboard expandedKey must be null or an existing widget key.');
      }
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
      controls.forEach(({ widget, button, path }) => {
        const expanded = widget.key === expandedKey;
        const label = expanded ? options.returnPresentation === 'back' ? 'Back' : 'Widget size' : 'Full size';
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
        button.setAttribute('aria-expanded', String(expanded));
        path.setAttribute('d', expanded ? options.returnPresentation === 'back' ? sizePaths.back : sizePaths.widget : sizePaths.full);
      });
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      controls.forEach(({ button, onClick }) => {
        button.removeEventListener('click', onClick);
        button.remove();
      });
      attributes.forEach(({ element, name, previous }) => {
        if (previous === null) element.removeAttribute(name);
        else element.setAttribute(name, previous);
      });
      mountedRoots.delete(root);
    }

    mountedRoots.add(root);
    root.setAttribute('data-dashboard', 'true');
    controls.forEach(({ button, parent, onClick }) => {
      parent.appendChild(button);
      button.addEventListener('click', onClick);
    });
    update({ expandedKey: null });
    return { update, dispose };
  }

  return { mount };
})();
