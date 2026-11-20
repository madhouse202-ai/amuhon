-- REVIEW-ONLY DRAFT. This file is outside supabase/migrations and has NOT been run.
-- All candidate and holder rows are status B; none is approved for sale.
-- The guard below intentionally aborts execution. Remove it only after human review,
-- replace the NULL audit fields in every row with genuine reviewer data, and re-review.
-- Do not change B to A as part of this draft.

begin;

do $rights_candidate_draft_guard$
begin
  raise exception 'Review-only rights candidate draft: human review and explicit editing are required before any registration';
end;
$rights_candidate_draft_guard$;

insert into public.amuhon_work_commercial_rights (
  work_id, text_edition_ref, source_sha256, title, author,
  card_url, text_url, xhtml_url, catalog_contributors, catalog_source_metadata,
  status, evidence_basis, checked_at, checked_by, rights_reviews_complete, permission_conditions
) values
  (
    '000799',
    'aozora-xhtml-sha256:d92a8aa62607a8269324f95a7ba8fe6ff71cd56de25b42af566679832109ff04',
    'd92a8aa62607a8269324f95a7ba8fe6ff71cd56de25b42af566679832109ff04',
    '夢十夜', '夏目 漱石',
    'https://www.aozora.gr.jp/cards/000148/card799.html',
    'https://www.aozora.gr.jp/cards/000148/files/799_ruby_6024.zip',
    'https://www.aozora.gr.jp/cards/000148/files/799_14972.html',
    '[{"name":"夏目 漱石","role":"著者"}]'::jsonb,
    '{"firstPublication":"","baseText":"夏目漱石全集10","basePublisher":"ちくま文庫、筑摩書房","inputter":"野口英司","proofreader":""}'::jsonb,
    'B',
    '候補確認中。公式カタログの作品・人物著作権フラグは「なし」。青空文庫の著作権消滅作家一覧に夏目漱石（1867-02-09–1916-12-09）の掲載あり。同一覧は青空文庫自身が目安・非網羅と説明している。図書カード記載：底本 夏目漱石全集10／ちくま文庫、筑摩書房、入力版 1996（平成8）年7月15日第5刷、入力者 野口英司。初出・校正者・校正版はカタログ／カード記載なし。個別商用レビュー未完了。根拠: https://www.aozora.gr.jp/cards/000148/card799.html ; https://www.aozora.gr.jp/siryo1.html ; https://www.aozora.gr.jp/guide/kijyunn.html',
    NULL::timestamptz,
    NULL::text,
    false,
    '未承認（B）。作品・本文版・関係者の個別確認が完了し、人が別途承認するまで商用販売・製本に使用しない。'
  ),
  (
    '001927',
    'aozora-xhtml-sha256:39bae724600360fbeb24f8fb0af7c9090bb4ab206139955b9d1a2c67a1527a45',
    '39bae724600360fbeb24f8fb0af7c9090bb4ab206139955b9d1a2c67a1527a45',
    '注文の多い料理店', '宮沢 賢治',
    'https://www.aozora.gr.jp/cards/000081/card1927.html',
    'https://www.aozora.gr.jp/cards/000081/files/1927_ruby_17835.zip',
    'https://www.aozora.gr.jp/cards/000081/files/1927_17906.html',
    '[{"name":"宮沢 賢治","role":"著者"}]'::jsonb,
    '{"firstPublication":"「イーハトヴ童話　注文の多い料理店」盛岡市杜陵出版部・東京光原社、1924（大正13）年12月1日","baseText":"宮沢賢治全集8","basePublisher":"ちくま文庫、筑摩書房","inputter":"土屋隆","proofreader":"noriko saito"}'::jsonb,
    'B',
    '候補確認中。公式カタログの作品・人物著作権フラグは「なし」。青空文庫の著作権消滅作家一覧に宮沢賢治（1896-08-27–1933-09-21）の掲載あり。同一覧は青空文庫自身が目安・非網羅と説明している。図書カード記載：初出 「イーハトヴ童話　注文の多い料理店」盛岡市杜陵出版部・東京光原社、1924-12-01、底本 宮沢賢治全集8／ちくま文庫、筑摩書房、入力・校正版 2004（平成16）年4月25日第20刷、入力 土屋隆、校正 noriko saito。個別商用レビュー未完了。根拠: https://www.aozora.gr.jp/cards/000081/card1927.html ; https://www.aozora.gr.jp/siryo1.html ; https://www.aozora.gr.jp/guide/kijyunn.html',
    NULL::timestamptz,
    NULL::text,
    false,
    '未承認（B）。作品・本文版・関係者の個別確認が完了し、人が別途承認するまで商用販売・製本に使用しない。'
  ),
  (
    '000042',
    'aozora-xhtml-sha256:646d4948414bc1d231375208421342657b82206f71979eac541f1e8f8b561174',
    '646d4948414bc1d231375208421342657b82206f71979eac541f1e8f8b561174',
    '鼻', '芥川 竜之介',
    'https://www.aozora.gr.jp/cards/000879/card42.html',
    'https://www.aozora.gr.jp/cards/000879/files/42_ruby_154.zip',
    'https://www.aozora.gr.jp/cards/000879/files/42_15228.html',
    '[{"name":"芥川 竜之介","role":"著者"}]'::jsonb,
    '{"firstPublication":"「新思潮」1916（大正5）年2月","baseText":"芥川龍之介全集1","basePublisher":"ちくま文庫、筑摩書房","inputter":"野口英司、平山誠","proofreader":"もりみつじゅんじ"}'::jsonb,
    'B',
    '候補確認中。公式カタログの作品・人物著作権フラグは「なし」。青空文庫の著作権消滅作家一覧に芥川龍之介（1892-03-01–1927-07-24）の掲載あり。同一覧は青空文庫自身が目安・非網羅と説明している。図書カード記載：初出 「新思潮」1916（大正5）年2月、底本 芥川龍之介全集1／ちくま文庫、筑摩書房、入力版 1997（平成9）年4月15日第14刷、入力 野口英司・平山誠、校正 もりみつじゅんじ。校正版はカード記載なし。個別商用レビュー未完了。根拠: https://www.aozora.gr.jp/cards/000879/card42.html ; https://www.aozora.gr.jp/siryo1.html ; https://www.aozora.gr.jp/guide/kijyunn.html',
    NULL::timestamptz,
    NULL::text,
    false,
    '未承認（B）。作品・本文版・関係者の個別確認が完了し、人が別途承認するまで商用販売・製本に使用しない。'
  )
on conflict (work_id, xhtml_url, source_sha256) do nothing;

insert into public.amuhon_work_rights_holders (
  work_id, xhtml_url, source_sha256, person_name, role, status,
  evidence_basis, checked_at, checked_by, permission_conditions
) values
  ('000799', 'https://www.aozora.gr.jp/cards/000148/files/799_14972.html', 'd92a8aa62607a8269324f95a7ba8fe6ff71cd56de25b42af566679832109ff04', '夏目 漱石', '著者', 'B', '公式カタログ・図書カードの著者役割と生没年、青空文庫の著作権消滅作家一覧を候補根拠として照合。青空文庫一覧は参考目安であり、この権利者の個別商用レビューは未完了。根拠: https://www.aozora.gr.jp/cards/000148/card799.html ; https://www.aozora.gr.jp/siryo1.html', NULL::timestamptz, NULL::text, '未承認（B）。個別権利・利用条件の人による確認と別途承認が完了するまで販売・製本に使用しない。'),
  ('001927', 'https://www.aozora.gr.jp/cards/000081/files/1927_17906.html', '39bae724600360fbeb24f8fb0af7c9090bb4ab206139955b9d1a2c67a1527a45', '宮沢 賢治', '著者', 'B', '公式カタログ・図書カードの著者役割と生没年、青空文庫の著作権消滅作家一覧を候補根拠として照合。青空文庫一覧は参考目安であり、この権利者の個別商用レビューは未完了。根拠: https://www.aozora.gr.jp/cards/000081/card1927.html ; https://www.aozora.gr.jp/siryo1.html', NULL::timestamptz, NULL::text, '未承認（B）。個別権利・利用条件の人による確認と別途承認が完了するまで販売・製本に使用しない。'),
  ('000042', 'https://www.aozora.gr.jp/cards/000879/files/42_15228.html', '646d4948414bc1d231375208421342657b82206f71979eac541f1e8f8b561174', '芥川 竜之介', '著者', 'B', '公式カタログ・図書カードの著者役割と生没年、青空文庫の著作権消滅作家一覧を候補根拠として照合。青空文庫一覧は参考目安であり、この権利者の個別商用レビューは未完了。根拠: https://www.aozora.gr.jp/cards/000879/card42.html ; https://www.aozora.gr.jp/siryo1.html', NULL::timestamptz, NULL::text, '未承認（B）。個別権利・利用条件の人による確認と別途承認が完了するまで販売・製本に使用しない。')
on conflict (work_id, xhtml_url, source_sha256, person_name, role) do nothing;

commit;
