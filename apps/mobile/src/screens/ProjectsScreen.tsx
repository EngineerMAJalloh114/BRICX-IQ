import { formatMoney, isCurrencyCode, toMinor } from '@bricx/shared';
import { usePowerSync, useQuery, useStatus } from '@powersync/react';
import { getLocales } from 'expo-localization';
import { useState } from 'react';
import { Button, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ProjectRecord } from '../db/schema';

const locale = getLocales()[0]?.languageTag;

export function ProjectsScreen() {
  const db = usePowerSync();
  const status = useStatus();
  const { data: projects } = useQuery<ProjectRecord>(
    'SELECT * FROM projects ORDER BY created_at DESC',
  );
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [budget, setBudget] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function addProject() {
    const code = currency.trim().toUpperCase();
    try {
      if (!name.trim()) throw new Error('Enter a project name');
      if (!isCurrencyCode(code)) throw new Error('Enter a 3-letter currency code');
      const budgetMinor = toMinor(budget || '0', code);
      const now = new Date().toISOString();
      // Written to the local database first, so this works offline; PowerSync
      // uploads it through the API when a connection is available.
      await db.execute(
        `INSERT INTO projects (id, name, currency, budget_minor, status, created_at, updated_at)
         VALUES (uuid(), ?, ?, ?, 'planning', ?, ?)`,
        [name.trim(), code, budgetMinor, now, now],
      );
      setName('');
      setBudget('');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Projects</Text>
      <Text style={styles.status}>
        {status.connected ? 'Synced' : 'Offline, changes saved on this device'}
      </Text>
      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder="Project name"
          value={name}
          onChangeText={setName}
        />
        <View style={styles.row}>
          <TextInput
            style={[styles.input, styles.currency]}
            placeholder="USD"
            autoCapitalize="characters"
            maxLength={3}
            value={currency}
            onChangeText={setCurrency}
          />
          <TextInput
            style={[styles.input, styles.flex]}
            placeholder="Budget"
            keyboardType="decimal-pad"
            value={budget}
            onChangeText={setBudget}
          />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button title="Add project" onPress={addProject} />
      </View>
      <FlatList
        data={projects}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.item}>
            <Text style={styles.itemName}>{item.name}</Text>
            <Text>
              {item.currency
                ? formatMoney(
                    { amountMinor: item.budget_minor ?? 0, currency: item.currency },
                    locale,
                  )
                : ''}{' '}
              · {item.status}
            </Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, paddingTop: 64, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '600' },
  status: { color: '#666', marginBottom: 16 },
  form: { gap: 8, marginBottom: 16 },
  row: { flexDirection: 'row', gap: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 10 },
  currency: { width: 72 },
  flex: { flex: 1 },
  error: { color: '#b00020' },
  item: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ddd' },
  itemName: { fontSize: 16, fontWeight: '500' },
});
