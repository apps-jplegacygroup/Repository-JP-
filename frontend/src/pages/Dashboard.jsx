import { useAuth } from '../context/AuthContext.jsx';

// Stub — se reemplaza en Step 6
export default function Dashboard() {
  const { user } = useAuth();
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400">
      Dashboard loading… ({user?.name})
    </div>
  );
}
