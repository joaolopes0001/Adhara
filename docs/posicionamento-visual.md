# Posicionamento visual — o critério

É regra do projeto: toda mudança de interface é conferida por este critério.

**O sentimento.** Um lugar confortável para trabalhar: o que você veio ver ocupa a tela, cada controle está onde se espera, e nada se mexe sem você pedir. Em três palavras: **leve, claro, coerente**.

Cada princípio traz uma pergunta que se responde olhando a tela e um exemplo do produto que a cumpre.

## Princípios de composição

| # | Regra | Pergunta de verificação | Exemplo que cumpre |
| --- | --- | --- | --- |
| 1 | **O conteúdo é o protagonista; o controle recua.** Nada com texto fica por cima do que o centro mostra. | Quantos controles cobrem um cartão ou um texto do centro? Meta: 0. | A linha de cabeçalho do mapa: legenda, zoom, **Enquadrar** e **Focar seleção** ficam numa linha acima do mapa, no lugar e na altura da linha de cabeçalho da Estrutura; na área do mapa ficam só cartões e setas; o crédito da biblioteca é a última linha da legenda. |
| 2 | **Cada ação mora num lugar, pelo tipo.** Sobre um objeto: no objeto ou no inspetor. Global: menus da barra de cima. Ferramenta e estado: barra de baixo. Nada pendurado numa borda. | Sobre o que este controle age? Ele está no lugar desse tipo? | **Abrir inspetor** age sobre o arquivo do cartão selecionado e é um link dentro do rodapé desse cartão, à esquerda das contagens; nada sai da borda do cartão. |
| 3 | **Hierarquia por espaço e letra, não por moldura.** Quatro tamanhos (11, 12, 13, 15), até três pesos; contorno só em campo e botão. | Quantos tamanhos e pesos de letra? Alguma letra abaixo de 11 px da tela, contando o zoom e a escala da tela? | A Estrutura: dois tamanhos de letra (12 px nos nomes e números; 11 px no cabeçalho das colunas, nas classes e nas contagens de itens) e dois pesos (o negrito só em pastas, instruções e na contagem de observações); as linhas não têm contorno, raio nem sombra, e as colunas se separam por espaço. |
| 4 | **A mesma coisa tem a mesma cara.** Aba, botão, fechar, confirmar, selecionado: uma forma cada. | Quantas formas tem a aba ativa? E o botão de texto? Meta: 1. | Excluir um projeto: o mesmo ×, com o mesmo nome acessível (“Excluir o projeto *nome* do aplicativo…”), em cada linha do Início e em cada projeto de **Abrir projeto**, e um só diálogo de confirmação para os dois: pequeno, com **Cancelar** em foco. A vista de um projeto não tem ×: ali, a forma de fechar seria confundida com tirar da frente, que é o –. |
| 5 | **Densidade regular, bordas alinhadas.** Linhas de uma lista têm a mesma altura; nada cortado nem encostado. | Quantas alturas de linha na mesma lista? Algum texto toca outro? Meta: 1 e 0. | As linhas do Início têm a altura, a letra e as colunas de número das linhas da Estrutura: uma altura só (30 px; 24 px numa janela baixa), também com 30 projetos, e o × de cada linha inteiro dentro dela. |
| 6 | **Movimento curto, onde algo muda de lugar.** O que muda de lugar desliza (120 a 240 ms); nada salta. | Quantos px andou, sem transição, algo que já estava na tela? Meta: 0. | O inspetor entra deslizando em 180 ms e sai em 160 ms; o mapa de uma nova seleção desliza do enquadramento anterior em 240 ms. Com movimento reduzido, tudo é imediato. |
| 7 | **Um gesto muda uma coisa.** | Quantas regiões mudaram com o clique (barras, explorador, centro, inspetor, painel, abas)? Meta: 1. | Com o inspetor fechado, o primeiro clique num cartão do mapa só o seleciona, e o mapa se enquadra nele; o inspetor abre no clique sobre o cartão já selecionado ou em **Abrir inspetor**. |
| 8 | **Cor diz uma coisa; ênfase, uma vez.** Um alerta é só cor: o texto ou o número que já está ali toma o tom, sem ícone. | Quantos significados tem este matiz? Quantas ênfases no mesmo trecho? Algum ícone marca um tom? Meta: 1, 1 e 0. | A linha de estado do editor, no pé do inspetor: a frase de um aviso ou de um problema vem na cor do tom, sem ícone nem caixa, sob uma linha de 1 px. |
| 9 | **Cada superfície tem uma função que as outras não têm.** Explorador: ir a um lugar. Centro: o que há no lugar. Inspetor: um arquivo. | Quantos nomes do centro estão também no explorador? Meta: só o lugar atual. | O Início é a lista dos projetos e aparece sem o explorador, cuja árvore repetiria os mesmos nomes; ele só entra ali se pedido e volta como estava ao entrar num projeto. |

## Formas que não entram

| Forma | No lugar |
| --- | --- |
| Caixa com borda lateral colorida, para aviso, nota ou confirmação | O texto na cor do tom, sem caixa; a faixa da janela, para a tela inteira; um diálogo, para confirmar |
| Selo, cápsula ou botão em cápsula (“3” em pílula, “desta sessão”) | Texto discreto (“Abertos · 3”); o botão padrão |
| Caixa dentro de caixa | Espaço e uma linha de 1 px |
| Ênfase ou fato repetido (negrito, cor, ícone e contorno no mesmo trecho; “2 problemas · 3 avisos” ao lado de um “5” colorido) | Uma vez |
| Ícone ao lado de um rótulo que já diz tudo; ícone de alerta (triângulo, “i” num círculo) para marcar um tom | Ícone só onde distingue classe ou substitui o texto; o tom, só pela cor |
| Grade de cartões iguais, sem dado | Lista com colunas |
| Gradiente, desfoque, sombra ou halo para chamar atenção | Fundo liso |
| Frase que explica a tela | O título e as colunas explicam |

## Onde entra um controle novo

1. Precisa existir? Um clique no objeto, um atalho ou um item de menu já faz isso?
2. Age sobre o quê? Objeto: no objeto ou no inspetor. Aplicativo: menu da barra de cima. Leitura: barra de baixo. Preferência: fim do menu Mais.
3. Com que frequência? Toda sessão: à vista. Raro: menu.
4. Já existe um controle com essa forma? Use a mesma; forma nova, só no lugar de uma antiga.
5. No lugar escolhido, cobre conteúdo ou quebra linha em 749×396? Então vai para a margem, o cabeçalho ou o inspetor.
6. Muda mais de uma região? Divida, ou encadeie com movimento.
7. Desfaz? Sim: faz na hora e oferece a volta na linha de avisos. Não: diálogo de confirmação.

## O que este critério não é

- Não é identidade visual: paleta e marca estão em `SPECS.md` §3, “Identidade visual”, e em `src/brand.css`.
- Não repete as regras de texto nem os antipadrões (`SPECS.md` §3, “Texto fixo da interface” e “Antipadrões”), nem substitui os testes de contraste e de alvo de clique. Trata de composição: onde cada coisa fica, com que forma, e como muda.
