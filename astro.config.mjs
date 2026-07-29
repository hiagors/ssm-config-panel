// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';

// Todas as chamadas AWS acontecem no backend, por isso `output: 'server'`.
// O bind é sempre em loopback: esta ferramenta serve valores de parâmetro
// decriptados e nunca deve escutar em 0.0.0.0.
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4321);

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],
  server: {
    host: HOST,
    port: PORT,
    // Defesa do servidor de dev contra DNS rebinding: só responde a requisição
    // cujo Host esteja nesta lista. O middleware aplica a mesma regra em dev e
    // em produção, mas fechar aqui também evita depender de uma camada só.
    allowedHosts: ['127.0.0.1', 'localhost'],
  },
  security: {
    // Já é o padrão no Astro 7; declarado para a intenção ficar no arquivo, e
    // para uma futura mudança de padrão não afrouxar a proteção em silêncio.
    // Valida Origin em requisição não-GET. O middleware complementa com a
    // checagem de Host, que isto não cobre.
    checkOrigin: true,
  },
  // Sessão desligada de forma explícita.
  //
  // O @astrojs/node habilita sessão com storage em **filesystem** quando
  // `session.driver` está ausente — é o que produzia a linha "Enabling
  // sessions with filesystem storage" no boot. Isso conflita frontalmente com
  // "valor de parâmetro nunca em disco fora de .backups/ e .local-store/":
  // bastaria alguém escrever `Astro.session.set(...)` uma vez para um segredo
  // ir para `.astro/sessions`.
  //
  // Não existe `session: false`. O driver `null` é o equivalente: nada é
  // armazenado em lugar nenhum. Evitar o uso não bastaria — o spec é explícito
  // em querer isto na configuração, para que voltar a ligar exija decisão
  // consciente, e não seja o padrão silencioso do adapter.
  session: {
    // Driver `null` do unstorage: aceita escrita e não guarda em lugar nenhum.
    // Declarado pelo `entrypoint` porque o objeto `sessionDrivers` do Astro tem
    // `null` em runtime mas não nos tipos — e depender de um buraco de tipagem
    // para desligar uma proteção é frágil.
    driver: { entrypoint: 'unstorage/drivers/null' },
  },
  vite: {
    resolve: {
      alias: {
        '@': new URL('./src', import.meta.url).pathname,
      },
    },
  },
});
