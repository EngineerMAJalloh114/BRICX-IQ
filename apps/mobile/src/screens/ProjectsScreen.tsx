import { ValidationError, validateProject, type ProjectInput } from '@bricx/shared';
import { usePowerSync, useStatus } from '@powersync/react';
import { useState } from 'react';
import { Button, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { errorMessage, newId, useMe, useProjects } from '../data';
import { t } from '../i18n';
import { styles as shared } from './styles';

export function ProjectsScreen({ onOpen }: { onOpen: (projectId: string) => void }) {
  const db = usePowerSync();
  const status = useStatus();
  const me = useMe();
  const projects = useProjects();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [currency, setCurrency] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function addProject() {
    if (!me) return;
    const input: ProjectInput = {
      name: name.trim(),
      code: code.trim() || null,
      currency: (currency.trim() || me.organisationCurrency).toUpperCase(),
      status: 'planning',
    };
    try {
      const errors = validateProject(input);
      if (errors.length) throw new ValidationError(errors);
      const now = new Date().toISOString();
      // Written to the local database first, so this works offline; PowerSync
      // uploads it through the API when a connection is available.
      await db.execute(
        `INSERT INTO projects (id, organisation_id, name, code, currency, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'planning', ?, ?, ?)`,
        [newId(), me.organisationId, input.name, input.code, input.currency, me.userId, now, now],
      );
      setName('');
      setCode('');
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <View style={shared.screen}>
      <Text style={shared.title}>{t('projects.title')}</Text>
      <Text style={shared.muted}>
        {status.connected ? t('projects.synced') : t('projects.offline')}
      </Text>
      {!me ? (
        <Text style={shared.muted}>{t('projects.noOrganisation')}</Text>
      ) : (
        <View style={shared.form}>
          <TextInput
            style={shared.input}
            placeholder={t('projects.namePlaceholder')}
            value={name}
            onChangeText={setName}
          />
          <View style={shared.row}>
            <TextInput
              style={[shared.input, shared.flex]}
              placeholder={t('projects.code')}
              value={code}
              onChangeText={setCode}
            />
            <TextInput
              style={[shared.input, shared.currency]}
              placeholder={me.organisationCurrency}
              autoCapitalize="characters"
              maxLength={3}
              value={currency}
              onChangeText={setCurrency}
            />
          </View>
          {error ? <Text style={shared.error}>{error}</Text> : null}
          <Button title={t('projects.add')} onPress={addProject} />
        </View>
      )}
      <FlatList
        data={projects}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable style={shared.item} onPress={() => onOpen(item.id)}>
            <Text style={styles.name}>
              {item.code ? `${item.code} · ` : ''}
              {item.name}
            </Text>
            <Text style={shared.muted}>
              {item.currency} · {t(`projects.status.${item.status}`)}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: 16, fontWeight: '500' },
});
