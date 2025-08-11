
# JokenpoAI 

Um jokenpô que **se adapta ao seu estilo**. Este documento explica como o modelo prevê sua próxima jogada, com as fórmulas matemáticas usadas, sinais coletados (tempo/hover do mouse), combinação de preditores e a política de decisão da IA.

---

## Como jogar (rápido)

- Informe seu nome na página inicial e clique **Jogar**.
- Na página do jogo, escolha **Tesoura**, **Pedra** ou **Papel**.
- São **50 partidas** por sessão; ao final, aparece um modal de vitória/derrota.
- **Reiniciar** reseta o progresso da sessão, mas o **aprendizado permanece** no navegador.

---

## Persistência e privacidade

Tudo roda **no seu navegador**:

- `localStorage`
  - `playerName`: seu nome.
  - `jkp_model`: estado de aprendizado (contadores, pesos, média de tempo etc.).
  - `jkp_history`: últimas jogadas/sinais (janela curta, para debug/estatística).
  - `jkp_totals`: totais agregados (vitórias/derrotas/empates entre sessões).
- **Sem backend**. Você pode limpar os dados a qualquer momento.

---

## Conjunto de movimentos

$$
\mathcal{M}=\{\text{tesoura},\,\text{pedra},\,\text{papel}\}
$$

Mapa de contra‑golpe:

$$
\text{COUNTER}(\text{tesoura})=\text{pedra},\quad
\text{COUNTER}(\text{pedra})=\text{papel},\quad
\text{COUNTER}(\text{papel})=\text{tesoura}.
$$

---

## Preditores (o que a IA observa)

A cada rodada o jogo produz **distribuições** $d_k$ sobre a **sua** próxima jogada. Cada preditor $k$ entrega $d_k(m)\in[0,1]$ para $m\in\mathcal{M}$. Em seguida combinamos todos (ver “Combinação”).

### 1) Frequência global

Contadores com **esquecimento exponencial** ($\lambda\in(0,1)$, padrão $\lambda=0.92$) e *smoothing* de Laplace $\alpha=1$:

$$
C_{\mathrm{freq}}^{(t)}(m)=\lambda\,C_{\mathrm{freq}}^{(t-1)}(m)+\mathbb{1}\{X_t=m\},
\qquad
d_{\mathrm{freq}}(m)=\frac{C_{\mathrm{freq}}(m)}{\sum_{u\in\mathcal{M}} C_{\mathrm{freq}}(u)}.
$$

### 2) Transições de 1ª ordem (Markov)

Matriz $C_{1}(i\to j)$ com esquecimento:

$$
C_{1}^{(t)}(i\to j)=\lambda\,C_{1}^{(t-1)}(i\to j)+\mathbb{1}\{X_{t-1}=i,\,X_t=j\}.
$$

Probabilidade (com Laplace $\alpha$):

$$
d_{\mathrm{t1}}(j\mid i)=\frac{C_{1}(i\to j)+\alpha}{\sum_{u\in\mathcal{M}}\!\bigl[C_{1}(i\to u)+\alpha\bigr]}.
$$

### 3) Transições de 2ª ordem

Bucket por par $(i,k)$ → próximo $j$:

$$
C_{2}^{(t)}\!\bigl((i,k)\to j\bigr)=\lambda\,C_{2}^{(t-1)}\!\bigl((i,k)\to j\bigr)+\mathbb{1}\{X_{t-2}=i,\,X_{t-1}=k,\,X_t=j\}.
$$

$$
d_{\mathrm{t2}}\bigl(j\mid (i,k)\bigr)=\frac{C_{2}\!\bigl((i,k)\to j\bigr)+\alpha}{\sum_{u\in\mathcal{M}}\!\bigl[C_{2}\!\bigl((i,k)\to u\bigr)+\alpha\bigr]}.
$$

### 4) Pós‑resultado (ganhou/perdeu/empatou)

Tendência condicional ao resultado da **rodada anterior** $r\in\{\mathrm{win},\mathrm{lose},\mathrm{draw}\}$:

$$
C_{r}^{(t)}(j)=\lambda\,C_{r}^{(t-1)}(j)+\mathbb{1}\{X_t=j\},
\qquad
d_{\mathrm{post}}(j\mid r)=\frac{C_{r}(j)+\alpha}{\sum_{u\in\mathcal{M}}\!\bigl[C_{r}(u)+\alpha\bigr]}.
$$

### 5) Repetição / anti‑repetição

Com base no último lance $x$ e **streak** $s$ (quantas vezes repetiu):

$$
d_{\mathrm{rep}}(m)\propto
\begin{cases}
1+\rho_s, & \text{se } m=x \text{ e } s\ge 2,\\
0.55, & \text{se } m=x \text{ e empate},\\
0.4\,\mathbb{1}\{m=x\}+0.6\,\mathbb{1}\{m=\mathrm{COUNTER}(x)\}, & \text{se perdeu},\\
1, & \text{se ganhou e } m=x.\\
\end{cases}
$$

(Depois normalizamos. Valores calibrados empiricamente.)

### 6) Padrões curtos (n‑gram)

- **ABAB** nos últimos 4: prevê **A**.  
- **ABCABC** nos últimos 6: tendência a **A** novamente.

Isso produz $d_{\mathrm{ngram}}$ concentrando massa no lance previsto.

### 7) Intenção por **hover** (sem hesitação)

Se $h_m$ é o tempo de hover por botão na rodada:

$$
d_{\mathrm{hover}}(m)=\frac{h_m}{\sum_{u\in\mathcal{M}} h_u}.
$$

### 8) Hesitação e “pivot” do mouse

**Métricas da rodada:** tempo de decisão $\Delta t$ (clique − início), número de trocas de hover (*switches*), e caminho $L$ do ponteiro.

**Média móvel do tempo** (padrão $\beta=0.1$):

$$
\mu \leftarrow (1-\beta)\,\mu + \beta\,\Delta t.
$$

**Flag de hesitação:**

$$
\text{hesitante} \iff \Delta t>\max\{700,\,1.25\,\mu\}\ \ \text{ou}\ \ \text{switches}\ge 3\ \ \text{ou}\ \ L>800.
$$

Se **hesitante**, pegamos o botão mais “namorado”:

```math
m^{*}=\underset{m\in\mathcal{M}}{\mathrm{arg\,max}}\,h_m
````

e usamos um mapeamento aprendido:

```math
P(\text{clique}=j \mid \text{mais-hover}=m^{*})
```

com contadores (com esquecimento):

```math
C_{\mathrm{pivot}}(m^{*}\to j)
```

```math
C_{\mathrm{pivot}}^{(t)}(m^{*}\to j)
= \lambda\,C_{\mathrm{pivot}}^{(t-1)}(m^{*}\to j)
+ \mathbf{1}\{\text{mais-hover}=m^{*},\, X_t=j\}
```

```math
d_{\mathrm{pivot}}(j \mid m^{*})
= \frac{C_{\mathrm{pivot}}(m^{*}\to j)+\alpha}
{\sum_{u\in\mathcal{M}}\bigl[C_{\mathrm{pivot}}(m^{*}\to u)+\alpha\bigr]}
```

---

## Combinação dos preditores

Cada preditor \$k\$ produz \$d\_k\$. Em tempo de jogo, aplicamos pesos por nível \$w\_k(L)\$ e um boost de desempenho do próprio preditor (quanto mais acerta, mais pesa):

$$
s(\mathrm{perf}_k)=0.6 + 1.6\,\mathrm{perf}_k \qquad (\mathrm{perf}_k \in [0,1]).
$$

**Distribuição final prevista do seu próximo lance:**

Seja

$$
Z=\sum_{u\in\mathcal{M}}\sum_{k} w_k(L)\, s(\mathrm{perf}_k)\, d_k(u)
$$

Então

$$
q(m)=\frac{\sum_{k} w_k(L)\, s(\mathrm{perf}_k)\, d_k(m)}{Z}
$$

**Ajuste dinâmico:** se \$\Delta t\$ for alto **e** a última rodada foi derrota, aumentamos o peso do repetidor:

$$
w_{\mathrm{rep}} \leftarrow 1.6\, w_{\mathrm{rep}}
$$

### Atualização do “desempenho” do preditor

Ao fim da rodada, reforçamos quem “apostou” mais na jogada que você realmente fez:

```math
\mathrm{perf}_k \leftarrow (1-\eta)\,\mathrm{perf}_k + \eta\, d_k\bigl(X_{t+1}\bigr)
```

onde \$ \eta=0.15 \$.

## Política da IA (ε‑greedy)

1. Com probabilidade \$\varepsilon\$, a IA **explora** (jogada uniforme).
2. Caso contrário, a IA escolhe a ação que **maximiza a chance de vitória** contra \$q\$:

```math
S(\text{pedra})=q(\text{tesoura}),\quad
S(\text{papel})=q(\text{pedra}),\quad
S(\text{tesoura})=q(\text{papel})
```

```math
a^{*}=
\begin{cases}
\mathrm{Uniform}(\mathcal{M}), & \text{com prob. }\varepsilon,\\[4pt]
\arg\max\limits_{a\in\mathcal{M}} S(a), & \text{caso contrário.}
\end{cases}
```

Se os \$S(a)\$ estiverem muito próximos (empate técnico), amostramos **proporcionalmente** a \$S(a)\$ para evitar determinismo.

---

## Progressão de dificuldade

* **Nível 0** (dados < 5 rodadas): ativa `freq` e `hover`; \$\varepsilon\approx 0.30\$.
* **Nível 1** (\$\ge 5\$): + `t1` e `post`; \$\varepsilon\approx 0.20\$.
* **Nível 2** (\$\ge 15\$): + `t2`, `rep`, `ngram`, `pivot`; \$\varepsilon\approx 0.12\$.
* **Nível 3** (\$\ge 40\$ rodadas **ou** winrate global do jogador \$>60%\$): aumenta pesos contextuais e reduz \$\varepsilon\approx 0.08\$.

> Entre sessões: o nível e os contadores aprendidos **persistem** no `localStorage`.

---

## Atualização online (resumo)

Para cada rodada \$t\$:

1. **Coleta de sinais** antes do clique: \$\Delta t,, h\_m,, \text{switches},, L\$.
2. **Preditores** geram \$d\_k\$.
3. **Combinação** → \$q\$.
4. **Política** ε‑greedy escolhe a jogada da IA.
5. Observamos o resultado \$r\_t\$.
6. **Atualização**:

   * contadores com esquecimento \$\lambda\$,
   * média \$\mu\$ do tempo com \$\beta\$,
   * `pivot` se **hesitante**,
   * \$\mathrm{perf}\_k\$ com \$\eta\$,
   * progresso/placar e histórico curto.

> Sessão reiniciada (progresso 0/50) ao recarregar; aprendizado **não** é apagado.

---

## Parâmetros (padrão)

* Esquecimento: \$\lambda=0.92\$.
* Laplace: \$\alpha=1\$.
* Aprendizagem de performance: \$\eta=0.15\$.
* Média móvel do tempo: \$\beta=0.1\$, base \$\mu\_{0}=700\$ ms.
* Hesitação: \$\Delta t>\max(700,1.25,\mu)\$ **ou** `switches ≥ 3` **ou** \$L>800\$ px.
* Peso extra do repetidor sob hesitação+derrota: multiplicador \$1.6\$.
* Exploração \$\varepsilon\$: 0.30 → 0.20 → 0.12 → 0.08 (por nível).

---

## Dicas para ajustar a dificuldade

* Aumente/diminua \$\lambda\$ para dar **mais/menos** peso ao recente.
* Suba o multiplicador do repetidor em hesitação se quiser punir indecisão.
* Reduza \$\varepsilon\$ nos níveis altos para IA mais “cirúrgica”.
* Aumente o peso de `t2` e `ngram` se os jogadores seguirem ciclos claros.

---

## Limitadores e fairness

* Em dispositivos **touch** sem “hover”, o preditor `hover/pivot` fica fraco; os demais seguram a IA.
* Não é lida nenhuma informação **após** o clique para decidir a jogada da IA; só sinais **anteriores** (tempo/hover/trajetória).

---

## Glossário rápido

* \$X\_t\$: sua jogada na rodada \$t\$.
* \$d\_k\$: distribuição prevista pelo preditor \$k\$.
* \$q\$: mistura final de previsões (próxima **sua** jogada).
* \$S(a)\$: score da ação da IA \$a\$.
* \$\varepsilon\$: taxa de exploração (aleatoriedade controlada).

