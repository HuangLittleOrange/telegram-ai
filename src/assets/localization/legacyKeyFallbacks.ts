import type { ApiOldLangString } from '../../api/types';

const zhHansFallbacks: Record<string, ApiOldLangString> = {
  lng_bot_allow_write_title: '允许此机器人发送消息？',
  lng_bot_allow_write: '允许后，此机器人可以主动给你发送消息。',
  lng_bot_allow_write_confirm: '允许',
  lng_bot_close_warning_title: '关闭此小程序？',
  lng_bot_close_warning: '关闭后，当前进度可能会丢失。',
  lng_bot_close_warning_sure: '仍要关闭',
  lng_channel_add_users: '添加成员',
  lng_channel_earn_balance_title: '可提现余额',
  lng_channel_earn_learn_in_about: '频道展示广告后会产生收益，收入将计入你的余额。',
  lng_channel_earn_learn_in_subtitle: '频道广告收入',
  lng_channel_earn_learn_out_about: '达到条件后可将余额提现到 TON 钱包。',
  lng_channel_earn_learn_out_subtitle: '提现到钱包',
  lng_channel_earn_learn_split_subtitle: '收益分成',
  lng_channel_earn_learn_title: '了解收益机制',
  lng_channel_earn_title: '收益',
  lng_contact_phone: '手机号',
  lng_context_cancel_download: '取消下载',
  lng_context_copy_image: '复制图片',
  lng_context_copy_link: '复制链接',
  lng_context_copy_message_link: '复制消息链接',
  lng_context_copy_selected: '复制已选内容',
  lng_context_copy_selected_items: '复制已选项',
  lng_context_copy_text: '复制文本',
  lng_context_forward_msg: '转发消息',
  lng_context_remove_from_group: '从群组移除',
  lng_context_report_msg: '举报',
  lng_context_save_gif: '保存 GIF',
  lng_context_translate: '翻译',
  lng_context_view_group: '查看群组',
  lng_context_view_topic: '查看话题',
  lng_create_permanent_link_title: '创建永久链接',
  lng_credits_box_out_about: '使用 Telegram Stars 即表示你同意 {link}。',
  lng_credits_summary_options_about: '使用 Telegram Stars 即表示你同意 {link}。',
  lng_credits_summary_options_about_link: '服务条款',
  lng_delete_for_everyone_hint: '消息将对所有成员删除。',
  lng_delete_for_me_chat_hint: '消息仅会从你的设备中删除。',
  lng_forum_create_topic: '创建话题',
  lng_forum_no_messages: '暂无消息',
  lng_forum_topic_close: '关闭话题',
  lng_forum_topic_delete: '删除话题',
  lng_forum_topic_edit: '编辑话题',
  lng_forum_topic_reopen: '重新开启话题',
  lng_forum_view_as_messages: '按消息查看',
  lng_group_invite_title: '邀请链接',
  lng_gift_link_about: '这是一个 Telegram Premium 兑换链接。',
  lng_gift_link_title: '礼品链接',
  lng_media_audio_empty: '暂无语音',
  lng_media_download: '下载',
  lng_media_file_empty: '暂无文件',
  lng_media_gif_empty: '暂无 GIF',
  lng_media_link_empty: '暂无链接',
  lng_media_song_empty: '暂无音乐',
  lng_new_contact_share: '分享我的手机号',
  lng_payments_card_cvc: '安全码（CVC）',
  lng_polls_retract: '撤回投票',
  lng_polls_stop: '结束投票',
  lng_polls_stop_sure: '结束',
  lng_polls_stop_warning: '确定要结束此投票吗？',
  lng_premium_emoji_status_title: '{user} 从 {link} 设置了表情状态',
  lng_report_story: '举报动态',
  lng_settings_about_bio: '个人简介',
  lng_settings_change_lang: '切换语言',
  lng_settings_experimental: '实验功能',
  lng_settings_information: '信息',
  lng_settings_sensitive_about: '显示可能包含敏感内容的媒体。',
  lng_settings_sensitive_disable_filtering: '关闭过滤',
  lng_settings_sensitive_title: '敏感内容',
  lng_settings_title_chat_name: '在窗口标题中显示聊天名称',
  lng_settings_window_system: '窗口与系统',
  lng_sure_logout: '确定要退出登录吗？',
  lng_username_link: '用户名链接',
  lng_username_purchase_available: '可在 {link} 购买更多用户名。',
  lng_usernames_description: '拖动可调整公开顺序，未启用的用户名不会显示。',
  lng_usernames_subtitle: '用户名管理',
};

const enFallbacks: Record<string, ApiOldLangString> = {
  lng_bot_allow_write_title: 'Allow this bot to send messages?',
  lng_bot_allow_write: 'If allowed, this bot can proactively send you messages.',
  lng_bot_allow_write_confirm: 'Allow',
  lng_bot_close_warning_title: 'Close this Mini App?',
  lng_bot_close_warning: 'Your current progress may be lost.',
  lng_bot_close_warning_sure: 'Close Anyway',
  lng_channel_add_users: 'Add Members',
  lng_channel_earn_balance_title: 'Available balance',
  lng_channel_earn_learn_in_about: 'When ads are shown in your channel, revenue is added to your balance.',
  lng_channel_earn_learn_in_subtitle: 'Ad Revenue',
  lng_channel_earn_learn_out_about: 'When requirements are met, you can withdraw to your TON wallet.',
  lng_channel_earn_learn_out_subtitle: 'Withdraw to Wallet',
  lng_channel_earn_learn_split_subtitle: 'Revenue Split',
  lng_channel_earn_learn_title: 'How Monetization Works',
  lng_channel_earn_title: 'Monetization',
  lng_contact_phone: 'Phone Number',
  lng_context_cancel_download: 'Cancel Download',
  lng_context_copy_image: 'Copy Image',
  lng_context_copy_link: 'Copy Link',
  lng_context_copy_message_link: 'Copy Message Link',
  lng_context_copy_selected: 'Copy Selected Text',
  lng_context_copy_selected_items: 'Copy Selected Items',
  lng_context_copy_text: 'Copy Text',
  lng_context_forward_msg: 'Forward Message',
  lng_context_remove_from_group: 'Remove from Group',
  lng_context_report_msg: 'Report',
  lng_context_save_gif: 'Save GIF',
  lng_context_translate: 'Translate',
  lng_context_view_group: 'View Group',
  lng_context_view_topic: 'View Topic',
  lng_create_permanent_link_title: 'Create Permanent Link',
  lng_credits_box_out_about: 'By using Telegram Stars, you agree to {link}.',
  lng_credits_summary_options_about: 'By using Telegram Stars, you agree to {link}.',
  lng_credits_summary_options_about_link: 'Terms of Service',
  lng_delete_for_everyone_hint: 'This message will be deleted for everyone.',
  lng_delete_for_me_chat_hint: 'This message will only be deleted for you.',
  lng_forum_create_topic: 'Create Topic',
  lng_forum_no_messages: 'No messages yet',
  lng_forum_topic_close: 'Close Topic',
  lng_forum_topic_delete: 'Delete Topic',
  lng_forum_topic_edit: 'Edit Topic',
  lng_forum_topic_reopen: 'Reopen Topic',
  lng_forum_view_as_messages: 'View as Messages',
  lng_group_invite_title: 'Invite Link',
  lng_gift_link_about: 'This is a Telegram Premium gift link.',
  lng_gift_link_title: 'Gift Link',
  lng_media_audio_empty: 'No voice messages yet',
  lng_media_download: 'Download',
  lng_media_file_empty: 'No files yet',
  lng_media_gif_empty: 'No GIFs yet',
  lng_media_link_empty: 'No links yet',
  lng_media_song_empty: 'No music yet',
  lng_new_contact_share: 'Share My Phone Number',
  lng_payments_card_cvc: 'Card CVC',
  lng_polls_retract: 'Retract Vote',
  lng_polls_stop: 'Stop Poll',
  lng_polls_stop_sure: 'Stop',
  lng_polls_stop_warning: 'Are you sure you want to stop this poll?',
  lng_premium_emoji_status_title: '{user} set an emoji status from {link}',
  lng_report_story: 'Report Story',
  lng_settings_about_bio: 'Bio',
  lng_settings_change_lang: 'Change Language',
  lng_settings_experimental: 'Experimental',
  lng_settings_information: 'Information',
  lng_settings_sensitive_about: 'Show media that may contain sensitive content.',
  lng_settings_sensitive_disable_filtering: 'Disable Filtering',
  lng_settings_sensitive_title: 'Sensitive Content',
  lng_settings_title_chat_name: 'Show chat name in window title',
  lng_settings_window_system: 'Window and System',
  lng_sure_logout: 'Are you sure you want to log out?',
  lng_username_link: 'Username Link',
  lng_username_purchase_available: 'You can purchase more usernames at {link}.',
  lng_usernames_description: 'Drag to reorder public usernames. Inactive usernames are hidden.',
  lng_usernames_subtitle: 'Manage Usernames',
};

const LEGACY_STRING_FALLBACKS_BY_LANG: Record<string, Record<string, ApiOldLangString>> = {
  en: enFallbacks,
  zh: zhHansFallbacks,
  'zh-hans': zhHansFallbacks,
};

function normalizeLangCode(langCode?: string) {
  return (langCode || 'en').toLowerCase().replace(/-raw$/, '');
}

function buildCandidateLangCodes(langCode?: string) {
  const normalized = normalizeLangCode(langCode);
  const base = normalized.split('-')[0];
  const candidates = [normalized];

  if (normalized.startsWith('zh')) {
    candidates.push('zh-hans', 'zh');
  } else if (base !== normalized) {
    candidates.push(base);
  }

  if (!candidates.includes('en')) {
    candidates.push('en');
  }

  return candidates;
}

export function getLegacySupplementalString(key: string, langCode?: string): ApiOldLangString | undefined {
  const candidates = buildCandidateLangCodes(langCode);
  for (const lang of candidates) {
    const value = LEGACY_STRING_FALLBACKS_BY_LANG[lang]?.[key];
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}
