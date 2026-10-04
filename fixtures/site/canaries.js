// Planted PII. The site uses these values and the harness greps every SDK payload for them.
// guard says when a value must not leave the browser; see e2e/lib/canaries.js.

export const CANARIES = {
  password_input: { value: 'SqCanaryPw-7Q2x9Lk', guard: 'always', where: 'typed into input[type=password]' },
  email_input: { value: 'sq.canary.input+3f9a@example.com', guard: 'inputs', where: 'typed into input[type=email]' },
  card_input: { value: '4929 1730 5612 0483', guard: 'inputs', where: 'typed into input[autocomplete=cc-number]' },
  text_input: { value: 'SqCanaryFreeText-51b', guard: 'inputs', where: 'typed into a plain text input' },
  textarea: { value: 'SqCanaryTextarea-c07', guard: 'inputs', where: 'typed into a textarea' },
  prefilled_input: { value: 'SqCanaryPrefill-e44', guard: 'inputs', where: 'value attribute of a text input in the HTML' },
  hidden_input: { value: 'sqcanarycsrf_8b31', guard: 'hidden_input', where: 'value of input[type=hidden]' },
  blocked_text: { value: 'SqCanaryBlocked-9fa', guard: 'always', where: 'text inside .rr-block [data-sq-block]' },
  url_query_token: { value: 'sqcanarytok_4b8e1d', guard: 'always', where: 'page URL ?token=' },
  url_fragment_token: { value: 'sqcanaryfrag_9c3a7e', guard: 'always', where: 'page URL #access_token=' },
  fetch_query_token: { value: 'sqcanaryapitok_2e7f', guard: 'always', where: 'fetch URL ?api_key=' },
  xhr_query_email: { value: 'sq.canary.query+77@example.com', guard: 'always', where: 'XHR URL ?email=' },
  error_url_token: { value: 'sqcanaryerrtok_6a1b', guard: 'always', where: 'URL with ?token= inside an error message' },
  body_password: { value: 'SqCanaryBodyPw-3n8', guard: 'always', where: 'password field of a fetch JSON body' },
  response_secret: { value: 'sqcanaryresp_5d0c', guard: 'always', where: 'JSON response body of /api/profile' },
  auth_header: { value: 'sqcanaryauthz_8f41', guard: 'always', where: 'Authorization header of an app fetch' },
  cookie_value: { value: 'sqcanarycookie_0e6d', guard: 'always', where: 'document.cookie' },
  storage_value: { value: 'sqcanarystore_a9f3', guard: 'always', where: 'localStorage' },
  xframe_input: { value: 'SqCanaryXFrame-11d', guard: 'always', where: 'typed into an input in a cross-origin iframe' },
  xframe_text: { value: 'sq.canary.xframe+0b@example.com', guard: 'always', where: 'text in a cross-origin iframe' },
  frame_text: { value: 'sq.canary.frame+d2@example.com', guard: 'frame_text', where: 'text in a same-origin iframe' },
  page_text_email: { value: 'sq.canary.text+19c@example.com', guard: 'text', where: 'visible page text' },
  page_text_card: { value: '4539 5827 1604 3814', guard: 'text', where: 'visible page text' },
  page_text_digits: { value: '8675309123456', guard: 'text', where: 'visible page text, a 13 digit run' },
  dom_href_token: { value: 'sqcanaryhref_3c9d', guard: 'dom_urls', where: 'a[href] query string in the DOM' },
  dom_src_sig: { value: 'sqcanaryimgsig_71e2', guard: 'dom_urls', where: 'img[src] query string in the DOM' },
  action_text_email: { value: 'sq.canary.chip+4d@example.com', guard: 'action_text', where: 'text of a clicked button (click name)' },
  referrer_token: { value: 'sqcanaryref_e5a0', guard: 'always', where: 'document.referrer query, from a page with an unsafe-url policy' },
  console_email: { value: 'sq.canary.console+5e@example.com', guard: 'console', where: 'console.error argument' },
  error_email: { value: 'sq.canary.err+2a@example.com', guard: 'pattern_scrub', where: 'thrown error message' },
};

export const canary = (id) => CANARIES[id].value;
