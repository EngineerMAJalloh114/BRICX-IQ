import { PowerSyncContext } from '@powersync/react';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { API_URL } from './src/config';
import { useMe } from './src/data';
import { BricxConnector } from './src/db/connector';
import { db } from './src/db/database';
import { ProjectScreen } from './src/screens/ProjectScreen';
import { ProjectsScreen } from './src/screens/ProjectsScreen';
import { getSession } from './src/session';

const connector = new BricxConnector({
  apiUrl: API_URL,
  getSession,
  onRejected: (status, body) => console.warn('Server rejected a local change', status, body),
});

function Screens() {
  const me = useMe();
  const [projectId, setProjectId] = useState<string | null>(null);
  if (projectId && me) {
    return <ProjectScreen projectId={projectId} me={me} onBack={() => setProjectId(null)} />;
  }
  return <ProjectsScreen onOpen={setProjectId} />;
}

export default function App() {
  useEffect(() => {
    db.connect(connector);
  }, []);

  return (
    <PowerSyncContext.Provider value={db}>
      <Screens />
      <StatusBar style="auto" />
    </PowerSyncContext.Provider>
  );
}
