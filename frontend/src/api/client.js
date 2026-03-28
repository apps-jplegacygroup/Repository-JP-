import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api/v1';
console.log('[api] baseURL:', BASE_URL);

const client = axios.create({
  baseURL: BASE_URL,
});

// Attach JWT on every request
client.interceptors.request.use((config) => {
  const token = localStorage.getItem('vp_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401 → clear session and redirect to login
client.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('vp_token');
      localStorage.removeItem('vp_user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default client;
