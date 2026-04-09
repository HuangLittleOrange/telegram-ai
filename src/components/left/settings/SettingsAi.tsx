import type { FC } from '../../../lib/teact/teact';
import type React from '../../../lib/teact/teact';
import {
  memo,
  useMemo,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { AiProvider } from '../../../types';
import type { IRadioOption } from '../../ui/RadioGroup';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLastCallback from '../../../hooks/useLastCallback';

import InputText from '../../ui/InputText';
import ListItem from '../../ui/ListItem';
import RadioGroup from '../../ui/RadioGroup';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  provider: AiProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  defaultContextLimit: number;
};

const SettingsAi: FC<OwnProps & StateProps> = ({
  isActive,
  provider,
  model,
  apiKey,
  baseUrl,
  defaultContextLimit,
  onReset,
}) => {
  const {
    setSettingOption,
    showNotification,
  } = getActions();

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const providerOptions = useMemo<IRadioOption[]>(() => {
    return [
      {
        label: 'OpenAI',
        value: 'openai',
      },
      {
        label: 'Gemini',
        value: 'gemini',
      },
    ];
  }, []);

  const updateAiSettings = useLastCallback((update: Partial<StateProps>) => {
    setSettingOption({
      aiSettings: {
        provider,
        model,
        apiKey,
        baseUrl,
        defaultContextLimit,
        ...update,
      },
    });
  });

  const handleProviderChange = useLastCallback((value: string) => {
    updateAiSettings({ provider: value as AiProvider });
  });

  const handleModelChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    updateAiSettings({ model: e.currentTarget.value });
  });

  const handleApiKeyChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    updateAiSettings({ apiKey: e.currentTarget.value });
  });

  const handleBaseUrlChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    updateAiSettings({ baseUrl: e.currentTarget.value });
  });

  const handleDefaultContextChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const parsed = Number(e.currentTarget.value);
    updateAiSettings({
      defaultContextLimit: Number.isFinite(parsed) && parsed > 0 ? parsed : defaultContextLimit,
    });
  });

  const handleClearKey = useLastCallback(() => {
    updateAiSettings({ apiKey: '' });
    showNotification({ message: 'API key cleared' });
  });

  return (
    <div className="settings-content custom-scroll">
      <div className="settings-item">
        <h4 className="settings-item-header">Provider</h4>
        <RadioGroup
          name="ai-provider"
          options={providerOptions}
          selected={provider}
          onChange={handleProviderChange}
        />
      </div>

      <div className="settings-item">
        <h4 className="settings-item-header">Model</h4>
        <InputText
          value={model}
          label="Model ID"
          onChange={handleModelChange}
        />
      </div>

      <div className="settings-item">
        <h4 className="settings-item-header">API</h4>
        <InputText
          value={apiKey}
          label="API Key"
          onChange={handleApiKeyChange}
        />
        <InputText
          value={baseUrl}
          label="Base URL (optional)"
          onChange={handleBaseUrlChange}
        />
        <p className="section-info">
          OpenAI-compatible providers can use a root URL like `https://api.minimaxi.com/v1`.
        </p>
        <ListItem icon="delete" narrow onClick={handleClearKey}>Clear API Key</ListItem>
        <p className="section-info">
          API key is stored in local browser cache. Do not use shared devices.
        </p>
      </div>

      <div className="settings-item">
        <h4 className="settings-item-header">Defaults</h4>
        <InputText
          value={String(defaultContextLimit)}
          label="Default context messages"
          inputMode="numeric"
          onChange={handleDefaultContextChange}
        />
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const {
      provider,
      model,
      apiKey,
      baseUrl,
      defaultContextLimit,
    } = global.settings.byKey.aiSettings;

    return {
      provider,
      model,
      apiKey,
      baseUrl,
      defaultContextLimit,
    };
  },
)(SettingsAi));
