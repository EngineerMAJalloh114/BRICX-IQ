import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, paddingTop: 64, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '600' },
  heading: { fontSize: 18, fontWeight: '600', marginTop: 20, marginBottom: 8 },
  muted: { color: '#666' },
  form: { gap: 8, marginVertical: 12 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 10 },
  currency: { width: 72 },
  flex: { flex: 1 },
  error: { color: '#b00020' },
  warning: { color: '#b45309', fontWeight: '600' },
  item: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ddd' },
  chip: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipSelected: { backgroundColor: '#1f2937', borderColor: '#1f2937' },
  chipText: { color: '#1f2937' },
  chipTextSelected: { color: '#fff' },
});
