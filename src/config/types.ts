export type OpenCarapaceBridgeChannelConfig = {
  enabled?: boolean;
  inbound_secret?: string;
  inbound_secret_file?: string;
  outbound_webhook_url?: string;
  outbound_webhook_url_file?: string;
};

export type OpenCarapaceConfig = {
  runtime?: {
    default_agent_id?: string;
    workspace_root?: string;
    session_store_file?: string;
    port?: number;
    gateway_port?: number;
  };
  agents?: {
    codex?: {
      enabled?: boolean;
      cli_command?: string;
      cli_args?: string[];
      cli_args_file?: string;
    };
    cloudcode?: {
      enabled?: boolean;
      cli_command?: string;
      cli_args?: string[];
      cli_args_file?: string;
    };
    claude_code?: {
      enabled?: boolean;
      cli_command?: string;
      cli_args?: string[];
      cli_args_file?: string;
    };
  };
  channels?: {
    routing?: {
      default_agent_id?: string;
      entries?: Record<string, string>;
    };
    telegram?: {
      enabled?: boolean;
      token?: string;
      token_file?: string;
      allowed_chat_ids?: string[];
      poll_timeout_seconds?: number;
      retry_delay_ms?: number;
    };
    slack?: OpenCarapaceBridgeChannelConfig;
    discord?: OpenCarapaceBridgeChannelConfig;
    wechat?: OpenCarapaceBridgeChannelConfig;
  };
  skills?: {
    enable_openclaw_catalog?: boolean;
    openclaw_root?: string;
    openclaw_skill_dirs?: string[];
    openclaw_max_selected_skills?: number;
    openclaw_max_snippet_chars?: number;
  };
};
