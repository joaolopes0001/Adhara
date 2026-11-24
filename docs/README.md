# Documentação

Uma fonte por assunto. Ao mudar o comportamento, atualize o documento dono do assunto, não uma cópia.

| Documento | Assunto | Público |
| --- | --- | --- |
| [README](../README.md) | O que é, instalar e executar | quem chega |
| [Guia de uso](guia-de-uso.md) | Interface, estado e remoção | usuários |
| [Modelo e leitura](modelo-e-leitura.md) | Extração, resolução, escopo, alcançabilidade, observações e limites (fonte única das regras do leitor) | usuários, contribuidores, agentes |
| [CLI](cli.md) | Contratos, comandos, relatórios e códigos de saída da CLI `aae` | quem automatiza (scripts, CI, agentes de código) |
| [SPECS](../SPECS.md) | Requisitos e contratos do produto | contribuidores, agentes |
| [Posicionamento visual](posicionamento-visual.md) | Critério de composição da interface: onde cada coisa fica, com que forma e como muda | contribuidores, agentes |
| [Decisões de arquitetura](architecture.md) | Por que o sistema é como é, por tema; caminho de uma leitura e pontos de atenção entre módulos | contribuidores, agentes |
| [Contribuir](../CONTRIBUTING.md) | Desenvolvimento, testes e política de evidências | contribuidores |
| [AGENTS.md](../AGENTS.md) | Regras do projeto para o agente de código de quem contribui ([para que serve](../README.md#desenvolver-com-agentes-de-código)) | agentes |
| [CLAUDE.md](../CLAUDE.md) | Importa o AGENTS.md e acrescenta o específico do Claude Code (permissões, skill `run-isolated`) | agentes |
| [Laboratório Aurora](audit-lab.md) | Filesystem fictício reproduzível com oráculo independente para auditoria | contribuidores |
| [Segurança](../SECURITY.md) | Como relatar uma vulnerabilidade; o que o servidor local fecha e o que não | usuários, contribuidores |
| [Código de conduta](../CODE_OF_CONDUCT.md) | O que se espera nas issues e pull requests, e como relatar um problema | contribuidores |
| [CHANGELOG](../CHANGELOG.md) | Mudanças por versão, com data | todos |

Evidência nova de testes fica em `test-results/`, fora do versionamento ([política](../CONTRIBUTING.md#evidências-e-dados)).
