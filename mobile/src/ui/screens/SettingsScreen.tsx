import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Button, Card, Field, Notice } from '../components/common';
import { colors, spacing, typography } from '../theme';

export interface SettingsScreenProps {
  initialServerUrl: string;
  initialApiKey: string;
  voiceEnabled: boolean;
  voiceAvailable: boolean;
  onSave: (input: { apiBaseUrl: string; apiKey: string }) => Promise<string>;
  onTest: (input: { apiBaseUrl: string; apiKey: string }) => Promise<string>;
  onVoiceToggle: (enabled: boolean) => Promise<void>;
  onBack: () => void;
}

type Feedback = { tone: 'success' | 'danger'; message: string } | null;

export function SettingsScreen(props: SettingsScreenProps) {
  const [serverUrl, setServerUrl] = useState(props.initialServerUrl);
  const [apiKey, setApiKey] = useState(props.initialApiKey);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'voice' | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const run = async (kind: 'save' | 'test', task: () => Promise<string>, success: (result: string) => string) => {
    setBusy(kind);
    setFeedback(null);
    try {
      const result = await task();
      setFeedback({ tone: 'success', message: success(result) });
    } catch (error) {
      setFeedback({ tone: 'danger', message: error instanceof Error ? error.message : 'The request failed.' });
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
      setVoiceError(error instanceof Error ? error.message : 'Voice commands could not be changed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.topRow}>
        <Button label="Back" variant="ghost" onPress={props.onBack} />
      </View>
      <Text style={typography.title}>Settings</Text>

      <Card>
        <Text style={typography.heading}>Server</Text>
        <Text style={typography.small}>
          The HTTPS address of your Reavailable server, for example https://audiobooks.example.com. Plain http:// works only in development builds.
        </Text>
        <Field
          label="Server address"
          value={serverUrl}
          onChangeText={setServerUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://audiobooks.example.com"
        />
        <Field
          label="Access key (only if the server asks for one)"
          value={apiKey}
          onChangeText={setApiKey}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder="Optional"
        />
        <View style={styles.buttonRow}>
          <Button
            label="Test connection"
            variant="secondary"
            busy={busy === 'test'}
            disabled={busy !== null}
            onPress={() =>
              run(
                'test',
                () => props.onTest({ apiBaseUrl: serverUrl, apiKey }),
                (version) => `Connected. Server version ${version}.`,
              )
            }
            style={styles.flex}
          />
          <Button
            label="Save"
            busy={busy === 'save'}
            disabled={busy !== null}
            onPress={() =>
              run(
                'save',
                () => props.onSave({ apiBaseUrl: serverUrl, apiKey }),
                (saved) => `Saved. Server: ${saved}`,
              )
            }
            style={styles.flex}
          />
        </View>
        {feedback ? <Notice tone={feedback.tone === 'success' ? 'success' : 'danger'}>{feedback.message}</Notice> : null}
      </Card>

      <Card>
        <View style={styles.voiceRow}>
          <View style={styles.flex}>
            <Text style={typography.heading}>Voice commands</Text>
            <Text style={typography.small}>
              Say “next”, “repeat”, “pause” or “resume” in English. Recognition runs on this phone and works without a
              connection. The microphone is used only while voice commands are on.
            </Text>
          </View>
          <Switch
            value={props.voiceEnabled}
            onValueChange={toggleVoice}
            disabled={!props.voiceAvailable || busy !== null}
            accessibilityLabel="Voice commands"
            trackColor={{ true: colors.primary, false: colors.border }}
          />
        </View>
        {!props.voiceAvailable ? (
          <Notice tone="warning">
            Voice commands need a development or release build that includes the speech module. They are not available
            in Expo Go.
          </Notice>
        ) : null}
        {voiceError ? <Notice tone="danger">{voiceError}</Notice> : null}
        <Text style={typography.small}>
          For best results use headphones. Speaker output can be picked up by the microphone and, in rare cases, read as
          a command.
        </Text>
      </Card>

      <Card>
        <Text style={typography.heading}>Storage and privacy</Text>
        <Text style={typography.small}>
          Audio is saved in the app’s own storage on this phone. Uninstalling the app, or clearing its data, deletes all
          audio on the phone. The server keeps audio only until this phone confirms it has the audio, and it removes
          unconfirmed audio after its retention period. Keep a copy of your text if you need one.
        </Text>
        <Text style={typography.small}>
          If the server copy expires before this phone has every part, the parts already on the phone are kept.
        </Text>
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
