import React, { useEffect, useRef, useState } from 'react';
import { OpenAISpeechTTS } from '@/libs/openaiTTS';
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
  const [openaiTtsModel, setOpenaiTtsModel] = useState(
    settings.globalReadSettings.openaiTtsModel || 'tts-1',
  );
  const [openaiTtsModels, setOpenaiTtsModels] = useState<string[]>([]);
  const [openaiTtsTestStatus, setOpenaiTtsTestStatus] = useState<{
    state: 'idle' | 'testing' | 'ok' | 'fail';
    message: string;
  }>({ state: 'idle', message: '' });
  const openaiTtsTestSeq = useRef(0);

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
  const saveOpenaiTtsSettings = (endpoint: string, apiKey: string, model = openaiTtsModel) => {
    if (
      endpoint === settings.globalReadSettings.openaiTtsEndpoint &&
      apiKey === settings.globalReadSettings.openaiTtsApiKey &&
      model === settings.globalReadSettings.openaiTtsModel
    ) {
      return;
    }
    settings.globalReadSettings.openaiTtsEndpoint = endpoint;
    settings.globalReadSettings.openaiTtsApiKey = apiKey;
    settings.globalReadSettings.openaiTtsModel = model;
    setSettings(settings);
    saveSettings(envConfig, settings);
  };

  const handleOpenaiTtsModelChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const model = event.target.value;
    setOpenaiTtsModel(model);
    saveOpenaiTtsSettings(openaiTtsEndpoint.trim(), openaiTtsApiKey.trim(), model);
  };

  // Connectivity test: health check, then voice + model counts. The seq guard
  // drops stale results when the user re-tests with an edited endpoint.
  const handleOpenaiTtsTest = async () => {
    const endpoint = openaiTtsEndpoint.trim();
    saveOpenaiTtsSettings(endpoint, openaiTtsApiKey.trim());
    if (!endpoint) {
      setOpenaiTtsTestStatus({ state: 'fail', message: _('Enter an endpoint URL first.') });
      return;
    }
    const seq = ++openaiTtsTestSeq.current;
    setOpenaiTtsTestStatus({ state: 'testing', message: _('Connecting…') });
    const tts = new OpenAISpeechTTS(endpoint, openaiTtsApiKey.trim());
    const available = await tts.checkAvailability();
    if (seq !== openaiTtsTestSeq.current) return;
    if (!available) {
      setOpenaiTtsTestStatus({ state: 'fail', message: _('Server not reachable.') });
      return;
    }
    const [voices, models] = await Promise.all([tts.fetchVoices(), tts.fetchModels()]);
    if (seq !== openaiTtsTestSeq.current) return;
    if (models.length > 0) {
      setOpenaiTtsModels(models);
      if (!models.includes(openaiTtsModel)) {
        setOpenaiTtsModel(models[0]!);
        saveOpenaiTtsSettings(endpoint, openaiTtsApiKey.trim(), models[0]!);
      }
    }
    if (voices.length > 0) {
      setOpenaiTtsTestStatus({
        state: 'ok',
        message: _('Connected — {{count}} voices available', { count: voices.length }),
      });
    } else {
      setOpenaiTtsTestStatus({
        state: 'fail',
        message: _('Connected, but the server reported no voices.'),
      });
    }
  };

  // Server-reported models when known (after a Test), else the standard OpenAI
  // names; the saved model always stays selectable.
  const baseModels = openaiTtsModels.length > 0 ? openaiTtsModels : ['tts-1', 'tts-1-hd'];
  const openaiTtsModelOptions = baseModels.includes(openaiTtsModel)
    ? baseModels
    : [openaiTtsModel, ...baseModels];

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
        <SettingsRow label={_('Model')}>
          <SettingsSelect
            value={openaiTtsModel}
            onChange={handleOpenaiTtsModelChange}
            ariaLabel={_('Model')}
            options={openaiTtsModelOptions.map((model) => ({ value: model, label: model }))}
          />
        </SettingsRow>
        <SettingsRow
          label={_('Connection')}
          description={
            openaiTtsTestStatus.state === 'idle' ? undefined : (
              <span
                className={
                  openaiTtsTestStatus.state === 'fail' ? 'text-error' : 'text-base-content/75'
                }
              >
                {openaiTtsTestStatus.message}
              </span>
            )
          }
        >
          <button
            type='button'
            className='btn btn-sm eink-bordered font-normal normal-case'
            disabled={openaiTtsTestStatus.state === 'testing'}
            onClick={handleOpenaiTtsTest}
          >
            {openaiTtsTestStatus.state === 'testing' ? _('Testing…') : _('Test')}
          </button>
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
