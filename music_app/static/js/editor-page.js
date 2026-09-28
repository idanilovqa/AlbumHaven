/* Reusable editor page footer. The owning controller supplies state and actions. */
(function (scope) {
  'use strict';
  const ButtonComponent = typeof module !== 'undefined' && module.exports ? require('./button-component.js') : scope.ButtonComponent;

  function mountFooter(container, options = {}) {
    const primary = options.primary || {};
    const secondary = options.secondary || {};
    container.innerHTML = `<footer class="editor-footer" data-editor-footer>
      ${ButtonComponent.renderButton({ label: options.resetLabel || 'Reset', variant: 'secondary', action: 'reset', className: 'button-secondary editor-footer-reset background-reset', attributes: { 'data-editor-footer-action': 'reset', 'data-background-reset': true, hidden: options.showReset === false } })}
      ${options.status ? `<p class="editor-footer-status" role="status">${String(options.status).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))}</p>` : ''}
      <div class="editor-footer-actions">${ButtonComponent.renderButton({ label: 'Try again', variant: 'secondary', action: 'retry', className: 'button-secondary', attributes: { 'data-editor-footer-action': 'retry', 'data-background-retry': true, hidden: true } })}
        ${ButtonComponent.renderButton({ label: secondary.label || 'Cancel', variant: 'secondary', quiet: true, action: 'secondary', className: 'button-secondary', attributes: { 'data-editor-footer-action': 'secondary', 'data-background-cancel': true, ...secondary.attributes } })}
        ${ButtonComponent.renderButton({ label: primary.label || 'Save', variant: 'primary', action: 'primary', className: 'background-save', attributes: { 'data-editor-footer-action': 'primary', 'data-background-save': true, disabled: !options.canSave, ...primary.attributes } })}</div>
    </footer>`;
    if (options.leadingElement) container.querySelector('[data-editor-footer]').prepend(options.leadingElement);
    const click = event => {
      const action = event.target?.closest?.('[data-editor-footer-action]')?.getAttribute('data-editor-footer-action');
      if (action === 'reset') options.onReset?.();
      else if (action === 'retry') options.onRetry?.();
      else if (action === 'secondary') secondary.action?.();
      else if (action === 'primary' && !event.target?.closest?.('[data-editor-footer-action]')?.disabled) primary.action?.();
    };
    container.addEventListener?.('click', click);
    return () => container.removeEventListener?.('click', click);
  }

  const api = { mountFooter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope) scope.EditorPage = api;
})(typeof window !== 'undefined' ? window : null);
