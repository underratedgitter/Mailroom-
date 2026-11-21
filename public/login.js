const form = document.getElementById('form');
const input = document.getElementById('password');
const button = document.getElementById('submit');
const error = document.getElementById('error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  button.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    });
    if (res.ok) {
      window.location.replace('/');
      return;
    }
    const data = await res.json().catch(() => ({}));
    error.textContent = data.error || 'Could not sign in';
    input.select();
  } catch {
    error.textContent = 'The server is not reachable';
  } finally {
    button.disabled = false;
  }
});
