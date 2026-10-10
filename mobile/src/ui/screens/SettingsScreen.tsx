import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import type { Language } from '../../core/types';
import { Button, Card, Field, Notice, Segmented } from '../components/common';
import { colors, spacing, typography } from '../theme';
import { useTranslate } from '../TranslateContext';

export interface SettingsScreenProps {
  initialServerUrl: string;
  initialApiKey: string;
  language: Language;
  voiceEnabled: boolean;
  voiceAvailable: boolean;
  /** Saves the address and key, then answers with a line to show. Rejects with wording to show. */
  onSave: (input: { apiBaseUrl: string; apiKey: string }) => Promise<string>;
  /** Contacts the server and answers with a line to show. Rejects with wording to show. */
  onTest: (input: { apiBaseUrl: string; apiKey: string }) => Promise<string>;
  onLanguageChange: (language: Language) => Promise<void>;
  onVoiceToggle: (enabled: boolean) => Promise<void>;
  onBack: () => void;
}

type Feedback = { tone: 'success' | 'danger'; message: string } | null;

export function SettingsScreen(props: SettingsScreenProps) {
  const t = useTranslate();
  const [serverUrl, setServerUrl] = useState(props.initialServerUrl);
  const [apiKey, setApiKey] = useState(props.initialApiKey);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'voice' | 'language' | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const run = async (kind: 'save' | 'test', task: () => Promise<string>) => {
    setBusy(kind);
    setFeedback(null);
    try {
      setFeedback({ tone: 'success', message: await task() });
    } catch (error) {
      setFeedback({
        tone: 'danger',
        message: error instanceof Error ? error.message : t('settings.requestFailed'),
      });
    } finally {
      setBusy(null);
    }
  };

  const toggleVoice = async (enabled: boolean) => {
    setVoiceError(null);
    setBusy('voice');
    try {
      await props.onVoiceToggle(enabled);
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : t('settings.voiceChangeError'));
    } finally {
      setBusy(null);
    }
  };

  const changeLanguage = async (language: Language) => {
    if (language === props.language) {
      return;
    }
    setBusy('language');
    try {
      await props.onLanguageChange(language);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.topRow}>
        <Button label={t('common.back')} variant="ghost" onPress={props.onBack} />
      </View>
      <Text style={typography.title}>{t('settings.title')}</Text>

      <Card>
        <Text style={typography.heading}>{t('settings.languageHeading')}</Text>
        <Text style={typography.small}>{t('settings.languageBody')}</Text>
        <Segmented<Language>
          label={t('settings.languageLabel')}
          value={props.language}
          onChange={(language) => void changeLanguage(language)}
          options={[
            { value: 'uz', label: t('settings.languageUz') },
            { value: 'en', label: t('settings.languageEn') },
          ]}
        />
        {busy === 'language' ? <Text style={typography.small}>{t('common.save')}…</Text> : null}
      </Card>

      <Card>
        <Text style={typography.heading}>{t('settings.serverHeading')}</Text>
        <Text style={typography.small}>{t('settings.serverHint')}</Text>
        <Field
          label={t('settings.serverAddress')}
          value={serverUrl}
          onChangeText={setServerUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://reavailable-api.example.workers.dev"
        />
        <Field
          label={t('settings.accessKey')}
          value={apiKey}
          onChangeText={setApiKey}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder={t('settings.accessKeyPlaceholder')}
        />
        <View style={styles.buttonRow}>
          <Button
            label={t('settings.test')}
            variant="secondary"
            busy={busy === 'test'}
            disabled={busy !== null}
            onPress={() => run('test', () => props.onTest({ apiBaseUrl: serverUrl, apiKey }))}
            style={styles.flex}
          />
          <Button
            label={t('common.save')}
            busy={busy === 'save'}
            disabled={busy !== null}
            onPress={() => run('save', () => props.onSave({ apiBaseUrl: serverUrl, apiKey }))}
            style={styles.flex}
          />
        </View>
        {feedback ? <Notice tone={feedback.tone === 'success' ? 'success' : 'danger'}>{feedback.message}</Notice> : null}
      </Card>

      <Card>
        <View style={styles.voiceRow}>
          <View style={styles.flex}>
            <Text style={typography.heading}>{t('settings.voiceHeading')}</Text>
            <Text style={typography.small}>{t('settings.voiceBody')}</Text>
          </View>
          <Switch
            value={props.voiceEnabled}
            onValueChange={toggleVoice}
            disabled={!props.voiceAvailable || busy !== null}
            accessibilityLabel={t('settings.voiceHeading')}
            trackColor={{ true: colors.primary, false: colors.border }}
          />
        </View>
        {!props.voiceAvailable ? <Notice tone="warning">{t('settings.voiceUnavailable')}</Notice> : null}
        {voiceError ? <Notice tone="danger">{voiceError}</Notice> : null}
        <Text style={typography.small}>{t('settings.voiceHeadphones')}</Text>
      </Card>

      <Card>
        <Text style={typography.heading}>{t('settings.storageHeading')}</Text>
        <Text style={typography.small}>{t('settings.storageBody')}</Text>
        <Text style={typography.small}>{t('settings.storageExpiry')}</Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xl },
  topRow: { flexDirection: 'row', justifyContent: 'flex-start' },
  flex: { flex: 1 },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
