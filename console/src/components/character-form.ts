/** 角色卡表单状态（新建 / 编辑共用；页面持有，CharacterFormFields 渲染）。 */
export interface CharacterFormState {
  name: string
  description: string
  personality: string
  scenario: string
  firstMes: string
}

export function emptyCharacterForm(): CharacterFormState {
  return { name: '', description: '', personality: '', scenario: '', firstMes: '' }
}
