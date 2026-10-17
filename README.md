# MRP Live Room

Compartilhamento de tela entre amigos, no estilo das calls do Discord.

## Rodar no seu PC

Só precisa do [Node.js](https://nodejs.org) (versão 16 ou mais nova). Não há nada para instalar com `npm`.

```bash
node server.js
```

Abra http://localhost:3000. Para usar outra porta: `PORT=8080 node server.js`.

## Deixar seus amigos entrarem

Navegadores só permitem compartilhar tela/câmera em **HTTPS** (ou em `localhost`). Para amigos em outras casas, escolha uma opção:

- **Hospedar (recomendado):** suba esta pasta no Render, Railway, Fly.io ou numa VPS. O comando de start é `node server.js`, e a porta vem da variável `PORT`.
- **Túnel temporário a partir do seu PC:** com o servidor rodando, use `cloudflared tunnel --url http://localhost:3000` (ou o ngrok) e envie o link `https://...` gerado.

### TURN: a "ponte" para redes que bloqueiam conexão direta

A conexão é direta entre os navegadores (P2P), usando STUN. Algumas redes bloqueiam essa conexão: 4G, redes corporativas, CGNAT de operadora. Quando isso acontece, quem assiste fica vendo "Reconectando à tela de...". A solução é um servidor TURN. Quem consegue conexão direta continua usando a conexão direta; só quem está bloqueado passa pela ponte.

**Cloudflare (recomendado):** os primeiros 1.000 GB por mês são grátis. Uma hora de 1080p para uma pessoa gasta cerca de 2 GB.

1. No painel da Cloudflare, vá em **Realtime → TURN Server** e crie uma chave (**Create**).
2. Anote o **Turn Token ID** e o **API Token**. Este segundo aparece uma vez só.
3. No Render, abra o serviço, vá em **Environment** e adicione:
   - `CF_TURN_KEY_ID` = Turn Token ID
   - `CF_TURN_API_TOKEN` = API Token
4. Salve. O Render reinicia o servidor, e o log deve mostrar `TURN Cloudflare: ativo`.

**TURN próprio (opcional):**
```
TURN_URL=turn:seu-servidor:3478   TURN_USER=usuario   TURN_PASS=senha
```

## Recursos

- **Prévia sincronizada:** quem transmite vê a própria tela com o mesmo fps e a mesma resolução que os amigos estão recebendo. O quadro mostra, por exemplo, "seu amigo recebe: 720p · 58fps", e avisa quando a imagem trava do lado de alguém.
- **Volume por transmissão:** cada tela com som tem um controle de volume.
- **Duas telas ao mesmo tempo:** clicar em uma delas faz ela ocupar o palco inteiro. O botão "Ver as duas telas" volta na hora, porque a outra tela continua conectada.
- **Reconexão automática:** se a conexão com o servidor cair (troca de Wi-Fi, 4G, internet saturada), o site percebe em até ~20 s e volta sozinho, com a mesma vaga. O vídeo continua passando durante a queda. Quem fecha a guia ou clica em Sair sai na hora.

## Como funciona e por que é leve

- **Só transmite para quem está assistindo.** A tela é codificada e enviada apenas para quem clicou em "Assistir". Se ninguém está assistindo, o custo é apenas o da captura.
- **A captura já sai no tamanho escolhido** (480p/720p/1080p, 30/60 fps), sem processar 4K para depois reduzir.
- **H.264 tem prioridade.** Normalmente é codificado e decodificado pela placa de vídeo, o que reduz bastante o uso de CPU.
- **Prioridade para fluidez.** Em 60 fps, a transmissão mantém a taxa de quadros e reduz a nitidez quando a rede aperta. Em 30 fps, privilegia a nitidez do texto.
- **Ao parar de assistir, a conexão é fechada**, e o decodificador libera a CPU e a GPU.
- **Câmera leve:** 640×360, 24 fps, 500 kbps, sem microfone.

- **Até 5 espectadores recebem direto de quem transmite.** O upload (16 Mbps no total) é dividido entre eles para não saturar a conexão. Com 2 pessoas assistindo em 1080p60, cada uma recebe 7 Mbps. Com 5 pessoas, cada uma recebe cerca de 3,2 Mbps.
- **Retransmissão só a partir do 6º espectador:** um espectador de PC repassa para até 2 outros, a até 3 Mbps. Celulares nunca retransmitem. Se quem retransmite sair, quem estava abaixo reconecta sozinho.
- **A fluidez vem antes da nitidez:** se a rede ou o PC apertarem, a imagem perde um pouco de nitidez, mas os quadros por segundo se mantêm.
- **Buffer de 120 ms para quem assiste:** absorve as oscilações da rede sem engasgar.
- **Indicador no quadro:** mostra a resolução e o fps que estão chegando de verdade.
- **Câmeras só quando aparecem na tela:** com alguém transmitindo e a fileira de membros fechada, as câmeras não são recebidas.
- **Um único ciclo de estatísticas a cada 2 s**, compartilhado por todas as funções.
- **Logo reduzida para 700 px:** o arquivo foi de 1,6 MB para 277 KB. O original está em `originais/`.

| Qualidade | 30 fps    | 60 fps   |
|-----------|-----------|----------|
| 480p      | 1,2 Mbps  | 2 Mbps   |
| 720p      | 2,5 Mbps  | 4 Mbps   |
| 1080p     | 4,5 Mbps  | 7 Mbps   |

(Os valores são por espectador e representam o máximo; com a tela parada o consumo cai bastante.)
