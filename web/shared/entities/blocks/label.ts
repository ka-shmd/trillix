import { type BlockKindContract } from './contract'

// Подпись поля — мелкая (компактные вопросы, поля регистрации). Отличие от title —
// только вид: семантика одна, обе подписи дают вопросу имя. В одной группе подпись
// одна (регруппировка второй туда не пускает), поэтому «title перебивает label» —
// страховка на схему извне, а не рабочее правило полотна.
export const label: BlockKindContract = {
  family: 'caption',
  carriesText: true,
  canShareRow: true,
  ownSettings: [],
  supportsPlaceholder: false,
  requiresCaption: false,
}
