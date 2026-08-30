const FINAL_RESULT_NONCE_ENV = 'ALBUM_HAVEN_PLAYWRIGHT_RESULT_NONCE';

let finalResultNonce = '';

function consumeFinalResultNonce() {
  const nonce = String(process.env[FINAL_RESULT_NONCE_ENV] || '');
  delete process.env[FINAL_RESULT_NONCE_ENV];
  if (nonce) {
    finalResultNonce = nonce;
  }
  return finalResultNonce;
}

consumeFinalResultNonce();

module.exports = {
  FINAL_RESULT_NONCE_ENV,
  consumeFinalResultNonce,
};
