import { createContext, useContext, useState, useEffect } from 'react';
import client from '../api/client';

const AuthContext = createContext(null);

// Token lives in localStorage (remember me) or sessionStorage (session only).
// We check localStorage first, then sessionStorage.
function readStorage(key) {
  return localStorage.getItem(key) ?? sessionStorage.getItem(key);
}

function clearStorage(key) {
  localStorage.removeItem(key);
  sessionStorage.removeItem(key);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const stored = readStorage('vp_user');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);

  // Validate stored token on mount
  useEffect(() => {
    const token = readStorage('vp_token');
    if (!token) { setLoading(false); return; }

    client.get('/auth/me')
      .then(({ data }) => setUser(data.user))
      .catch(() => {
        clearStorage('vp_token');
        clearStorage('vp_user');
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  async function login(email, password, rememberMe = false) {
    const { data } = await client.post('/auth/login', { email, password });
    const storage = rememberMe ? localStorage : sessionStorage;
    storage.setItem('vp_token', data.token);
    storage.setItem('vp_user', JSON.stringify(data.user));
    // Always persist email so the field is pre-filled on next visit
    localStorage.setItem('vp_remember_email', email);
    setUser(data.user);
    return data.user;
  }

  function logout() {
    clearStorage('vp_token');
    clearStorage('vp_user');
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
