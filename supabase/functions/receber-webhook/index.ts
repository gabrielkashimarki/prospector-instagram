// Edge Function do Supabase: recebe o aviso da Meta ou da Zernio e grava em `caixa_eventos`.
// O computador que roda o prospector vê o evento e sincroniza a caixa pela API na hora.
// Deploy: supabase functions deploy receber-webhook --no-verify-jwt (o README explica).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { responder } from "./logica.ts";

// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY o próprio Supabase injeta. Os outros vêm de `supabase secrets set`.
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve((req) =>
  responder(
    req,
    {
      metaSegredo: Deno.env.get("META_APP_SECRET"),
      metaTokenVerificacao: Deno.env.get("META_VERIFY_TOKEN"),
      zernioSegredo: Deno.env.get("ZERNIO_WEBHOOK_SECRET"),
    },
    async (provedor, corpo) => {
      const { error } = await supabase.from("caixa_eventos").insert({ provedor, payload: corpo, processado: 0, recebido_em: new Date().toISOString() });
      if (error) throw new Error(`Não gravei o evento: ${error.message}`);
    },
  ),
);
