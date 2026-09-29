import { PowerSyncContext } from '@powersync/react';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { API_URL } from './src/config';
import { BricxConnector } from './src/db/connector';
import { db } from './src/db/database';
import { ProjectsScreen } from './src/screens/ProjectsScreen';
import { getSession } from './src/session';

const connector = new BricxConnector({
  apiUrl: API_URL,
  getSession,
  onRejected: (status, body) => console.warn('Server rejected a local change', status, body),
});

export default function App() {
  useEffect(() => {
    db.connect(connector);
  }, []);

  return (
    <PowerSyncContext.Provider value={db}>
      <ProjectsScreen />
      <StatusBar style="auto" />
    </PowerSyncContext.Provider>
  );
}
