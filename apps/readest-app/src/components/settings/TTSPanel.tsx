import React, { useEffect, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useResetViewSettings } from '@/hooks/useResetSettings';
import { useTranslation } from '@/hooks/useTranslation';
import { saveViewSettings } from '@/helpers/settings';
import { SettingsPanelPanelProp } from './SettingsDialog';
import { TTSHighlightGranularity, TTSMediaMetadataMode } from '@/services/tts/types';
import { BoxedList, SettingsInput, SettingsRow, SettingsSelect, Tips } from './primitives';
import TTSHighlightStyleEditor, { TTSHighlightStyle } from './color/TTSHighlightStyleEditor';

const TTSPanel: React.FC<SettingsPanelPanelProp> = ({ bookKey, onRegisterReset }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { getViewSettings } = useReaderStore();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const viewSettings = getViewSettings(bookKey) || settings.globalViewSettings;

  const [ttsMediaMetadata, setTtsMediaMetadata] = useState<TTSMediaMetadataMode>(
    viewSettings.ttsMediaMetadata ?? 'sentence',
  );
  const [ttsHighlightGranularity, setTtsHighlightGranularity] = useState<TTSHighlightGranularity>(
    viewSettings.ttsHighlightGranularity ?? 'word',
  );
  const [ttsHighlightStyle, setTtsHighlightStyle] = useState(
    viewSettings.ttsHighlightOptions.style,
  );
  const [ttsHighlightColor, setTtsHighlightColor] = useState(
    viewSettings.ttsHighlightOptions.color,
  );
  const [customTtsHighlightColors, setCustomTtsHighlightColors] = useState(
    settings.globalReadSettings.customTtsHighlightColors || [],
  );
  const [openaiTtsEndpoint, setOpenaiTtsEndpoint] = useState(
    settings.globalReadSettings.openaiTtsEndpoint || '',
  );
  const [openaiTtsApiKey, setOpenaiTtsApiKey] = useState(
    settings.globalReadSettings.openaiTtsApiKey || '',
  );

  const resetToDefaults = useResetViewSettings();

  const handleReset = () => {
    resetToDefaults({
      ttsMediaMetadata: setTtsMediaMetadata as React.Dispatch<React.SetStateAction<string>>,
      ttsHighlightGranularity: setTtsHighlightGranularity as React.Dispatch<
        React.SetStateAction<string>
      >,
    });
  };

  useEffect(() => {
    onRegisterReset(handleReset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ttsMediaMetadata === viewSettings.ttsMediaMetadata) return;
    saveViewSettings(envConfig, bookKey, 'ttsMediaMetadata', ttsMediaMetadata, false, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsMediaMetadata]);

  useEffect(() => {
    if (ttsHighlightGranularity === viewSettings.ttsHighlightGranularity) return;
    saveViewSettings(
      envConfig,
      bookKey,
      'ttsHighlightGranularity',
      ttsHighlightGranularity,
      false,
      false,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsHighlightGranularity]);

  const handleTTSStyleChange = (style: TTSHighlightStyle) => {
    setTtsHighlightStyle(style);
    saveViewSettings(envConfig, bookKey, 'ttsHighlightOptions', {
      style,
      color: ttsHighlightColor,
    });
  };

  const handleTTSColorChange = (color: string) => {
    setTtsHighlightColor(color);
    saveViewSettings(envConfig, bookKey, 'ttsHighlightOptions', {
      style: ttsHighlightStyle,
      color,
    });
  };

  const handleCustomTtsColorsChange = (colors: string[]) => {
    setCustomTtsHighlightColors(colors);
    settings.globalReadSettings.customTtsHighlightColors = colors;
    setSettings(settings);
    saveSettings(envConfig, settings);
  };

  const handleMediaMetadataChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setTtsMediaMetadata(event.target.value as TTSMediaMetadataMode);
  };

  const handleTTSGranularityChange = (granularity: TTSHighlightGranularity) => {
    setTtsHighlightGranularity(granularity);
  };

  // Persisted on blur; the OpenAI-compatible client reads these the next time
  // Read Aloud starts (TTSController.init constructs the client from them).
  const saveOpenaiTtsSettings = (endpoint: string, apiKey: string) => {
    if (
      endpoint === settings.globalReadSettings.openaiTtsEndpoint &&
      apiKey === settings.globalReadSettings.openaiTtsApiKey
    ) {
      return;
    }
    settings.globalReadSettings.openaiTtsEndpoint = endpoint;
    settings.globalReadSettings.openaiTtsApiKey = apiKey;
    setSettings(settings);
    saveSettings(envConfig, settings);
  };

  return (
    <div className='my-4 w-full space-y-6'>
      <TTSHighlightStyleEditor
        granularity={ttsHighlightGranularity}
        style={ttsHighlightStyle}
        color={ttsHighlightColor}
        customColors={customTtsHighlightColors}
        onGranularityChange={handleTTSGranularityChange}
        onStyleChange={handleTTSStyleChange}
        onColorChange={handleTTSColorChange}
        onCustomColorsChange={handleCustomTtsColorsChange}
        data-setting-id='settings.tts.ttsHighlightStyle'
      />

      <BoxedList title={_('Media Info')} data-setting-id='settings.tts.mediaMetadata'>
        <SettingsRow label={_('Update Frequency')}>
          <SettingsSelect
            value={ttsMediaMetadata}
            onChange={handleMediaMetadataChange}
            ariaLabel={_('Update Frequency')}
            options={[
              { value: 'sentence', label: _('Every Sentence') },
              { value: 'paragraph', label: _('Every Paragraph') },
              { value: 'chapter', label: _('Every Chapter') },
            ]}
          />
        </SettingsRow>
      </BoxedList>

      <BoxedList title={_('OpenAI-Compatible TTS')} data-setting-id='settings.tts.openaiCompatible'>
        <SettingsRow label={_('Endpoint')}>
          <SettingsInput
            type='url'
            value={openaiTtsEndpoint}
            placeholder='http://localhost:8787'
            spellCheck={false}
            autoCapitalize='off'
            autoCorrect='off'
            aria-label={_('Endpoint')}
            onChange={(e) => setOpenaiTtsEndpoint(e.target.value)}
            onBlur={() => saveOpenaiTtsSettings(openaiTtsEndpoint.trim(), openaiTtsApiKey)}
          />
        </SettingsRow>
        <SettingsRow label={_('API Key')}>
          <SettingsInput
            type='password'
            value={openaiTtsApiKey}
            placeholder={_('Optional')}
            spellCheck={false}
            autoCapitalize='off'
            autoCorrect='off'
            aria-label={_('API Key')}
            onChange={(e) => setOpenaiTtsApiKey(e.target.value)}
            onBlur={() => saveOpenaiTtsSettings(openaiTtsEndpoint.trim(), openaiTtsApiKey.trim())}
          />
        </SettingsRow>
      </BoxedList>
      <Tips>
        <li>
          {_(
            'Point this at a self-hosted OpenAI-compatible speech server to add its voices to Read Aloud.',
          )}
        </li>
        <li>{_('Changes take effect the next time Read Aloud starts.')}</li>
      </Tips>
    </div>
  );
};

export default TTSPanel;
