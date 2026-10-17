// Pure publication DTO projections. A receipt is never current link authority.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const receiptFields = ['state', 'share_ref', 'link_revision', 'publication_ref', 'publication_revision'];
const ownerFields = ['public_path', 'public_url', 'deployment_available', 'can_enable_external', 'can_revoke_external'];
const invalid = status => Object.assign(new Error('Invalid Album Top publication.'), {status});

export const isPublicationRevision = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
  && (value.length < 19 || value <= '9223372036854775807');

function receipt(value, status) {
  if (!record(value) || !receiptFields.every(key => Object.hasOwn(value, key))
    || !['unpublished', 'enabled', 'revoked'].includes(value.state)) throw invalid(status);
  const {state, share_ref, link_revision, publication_ref, publication_revision} = value;
  if (state === 'unpublished') {
    if ([share_ref, link_revision, publication_ref, publication_revision].some(field => field !== null)) throw invalid(status);
  } else {
    if (!uuid(share_ref) || !isPublicationRevision(link_revision)) throw invalid(status);
    if (state === 'enabled' ? !uuid(publication_ref) || !isPublicationRevision(publication_revision)
      : publication_ref !== null || publication_revision !== null) throw invalid(status);
  }
  return {state, share_ref, link_revision, publication_ref, publication_revision};
}

function savedUrl(value, path) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password
      && url.pathname === path && !url.search && !url.hash && url.href === value && value === url.origin + path;
  } catch {return false;}
}

export function projectOwnerPublication(value) {
  const result = receipt(value, 409);
  if (!ownerFields.every(key => Object.hasOwn(value, key))
    || !['deployment_available', 'can_enable_external', 'can_revoke_external'].every(key => typeof value[key] === 'boolean')
    || value.can_enable_external && !value.deployment_available) throw invalid(409);
  if (result.state === 'enabled') {
    const path = '/public/album-tops/' + result.share_ref;
    if (value.public_path !== path || !value.can_revoke_external
      || (value.deployment_available ? !savedUrl(value.public_url, path) : value.public_url !== null)) throw invalid(409);
  } else if (value.public_path !== null || value.public_url !== null || value.can_revoke_external) throw invalid(409);
  return {...result, public_path: value.public_path, public_url: value.public_url,
    deployment_available: value.deployment_available, can_enable_external: value.can_enable_external,
    can_revoke_external: value.can_revoke_external};
}

export function projectPublicationReceipt(value) {
  return receipt(value, 502);
}
