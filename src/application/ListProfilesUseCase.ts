import type { AwsProfile } from '../domain/AwsProfile.js';
import type { SsoAuthPort } from '../infrastructure/auth/SsoAuthPort.js';

/**
 * Lista os profiles para a tela inicial.
 *
 * Devolve também os não utilizáveis, marcados. Esconder um profile bloqueado
 * não ajudaria: quem procura `default` na lista e não acha conclui que a
 * ferramenta está quebrada, em vez de entender que aquele profile usa chave
 * estática e por isso está fora.
 */
export interface ListProfilesResult {
  readonly profiles: readonly AwsProfile[];
  /** Nome vindo de `AWS_PROFILE`, se existir e estiver utilizável. */
  readonly preselected: string | undefined;
  /** `true` quando nenhum profile SSO existe — a ferramenta não tem o que usar. */
  readonly hasNoUsableProfile: boolean;
}

export class ListProfilesUseCase {
  constructor(private readonly auth: SsoAuthPort) {}

  async execute(preselectedFromEnvironment: string | undefined): Promise<ListProfilesResult> {
    const profiles = await this.auth.listProfiles();
    const usable = profiles.filter((profile) => profile.selectable);

    // Só pré-seleciona se der para usar de fato. Pré-selecionar um profile
    // bloqueado deixaria a tela inicial num estado sem saída.
    const preselected = usable.some((profile) => profile.name === preselectedFromEnvironment)
      ? preselectedFromEnvironment
      : undefined;

    return {
      profiles,
      preselected,
      hasNoUsableProfile: usable.length === 0,
    };
  }
}
