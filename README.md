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

### TURN (opcional)

A conexão é direta entre os navegadores (P2P), usando STUN. Em algumas redes (4G, redes corporativas, NAT simétrico) a conexão direta falha. Nesses casos, configure um servidor TURN:

```
TURN_URL=turn:seu-servidor:3478   TURN_USER=usuario   TURN_PASS=senha
```

## Como funciona e por que é leve

- **Só transmite para quem está assistindo.** A tela é codificada e enviada apenas para quem clicou em "Assistir". Se ninguém está assistindo, o custo é apenas o da captura.
- **A captura já sai no tamanho escolhido** (480p/720p/1080p, 30/60 fps), sem processar 4K para depois reduzir.
- **H.264 tem prioridade.** Normalmente é codificado e decodificado pela placa de vídeo, o que reduz bastante o uso de CPU.
- **Prioridade para fluidez.** Em 60 fps, a transmissão mantém a taxa de quadros e reduz a nitidez quando a rede aperta. Em 30 fps, privilegia a nitidez do texto.
- **Ao parar de assistir, a conexão é fechada**, e o decodificador libera a CPU e a GPU.
- **Câmera leve:** 640×360, 24 fps, 500 kbps, sem microfone.

Limite prático: como a conexão é P2P, quem transmite envia uma cópia para cada pessoa que assiste. Para até ~4 espectadores em 1080p60 isso funciona bem numa conexão de upload comum. Para mais gente, reduza para 720p.

| Qualidade | 30 fps    | 60 fps   |
|-----------|-----------|----------|
| 480p      | 1,2 Mbps  | 2 Mbps   |
| 720p      | 2,5 Mbps  | 4 Mbps   |
| 1080p     | 4,5 Mbps  | 7 Mbps   |

(Os valores são por espectador e representam o máximo; com a tela parada o consumo cai bastante.)
