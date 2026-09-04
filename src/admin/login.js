const form = document.getElementById('loginForm');
const password = document.getElementById('password');
const button = document.getElementById('submitButton');
const message = document.getElementById('message');
const requestedNext = new URLSearchParams(window.location.search).get('next');
const nextPath = requestedNext && requestedNext.startsWith('/') && !requestedNext.startsWith('//') && !requestedNext.includes('\\') ? requestedNext : '/app';

form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  message.textContent = '';
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not sign in.');
    window.location.assign(nextPath);
  } catch (error) {
    password.value = '';
    password.focus();
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
