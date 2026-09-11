// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

import { aimZone, inZone, useClusterAim, type Box } from './clusterAim'

// Диагональ к значкам: кластер держится, пока курсор, ушедший с носителя влево, стоит
// между его левым краем и кластером. Hover в happy-dom геометрии не имеет, поэтому
// проверяются две половины порознь: зона — геометрией, метка `data-aim` — событиями с
// координатами. Поведение целиком проверено в браузере стендом (JOURNAL, «Треугольник
// намерения у кластера значков»): юнит, собранный из точек СЕРЕДИНЫ пути, пропустил
// дефект, при котором метку снимала сама точка выхода, — поэтому она здесь первая.

// Раскладка как на полотне: кластер слева от строки у её первой линии, строка высокая.
const ROW: Box = { left: 180, top: 94, right: 700, bottom: 400 }
const CLUSTER: Box = { left: 104, top: 100, right: 176, bottom: 128 } // mr-1 = 4px

describe('зона диагонали', () => {
  const zone = aimZone(ROW, CLUSTER)

  it('точки выхода с левого края — в зоне, в том числе у самого низа', () => {
    expect(inZone({ x: 175, y: 200 }, zone)).toBe(true)
    expect(inZone({ x: 175, y: 380 }, zone)).toBe(true)
    expect(inZone({ x: 175, y: 398 }, zone)).toBe(true)
  })

  it('диагональ снизу к значкам и стоянка на ней — в зоне', () => {
    expect(inZone({ x: 160, y: 330 }, zone)).toBe(true)
    expect(inZone({ x: 140, y: 240 }, zone)).toBe(true)
    expect(inZone({ x: 120, y: 150 }, zone)).toBe(true)
  })

  it('сам кластер и запас вокруг него — в зоне', () => {
    expect(inZone({ x: 130, y: 110 }, zone)).toBe(true)
    expect(inZone({ x: 98, y: 95 }, zone)).toBe(true)
  })

  it('ниже носителя, выше значков, левее значков и под диагональю — вне зоны', () => {
    expect(inZone({ x: 170, y: 430 }, zone)).toBe(false)
    expect(inZone({ x: 130, y: 70 }, zone)).toBe(false)
    expect(inZone({ x: 80, y: 200 }, zone)).toBe(false)
    expect(inZone({ x: 110, y: 380 }, zone)).toBe(false)
  })
})

function Carrier() {
  const { clusterRef, onPointerEnter, onPointerLeave } = useClusterAim()
  return (
    <div data-testid="carrier" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <div data-testid="cluster" ref={clusterRef} />
    </div>
  )
}

const rect = (b: Box) => ({
  ...b,
  x: b.left,
  y: b.top,
  width: b.right - b.left,
  height: b.bottom - b.top,
  toJSON: () => ({}),
})

describe('метка data-aim', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return rect(this.dataset.testid === 'cluster' ? CLUSTER : ROW)
    })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const leave = (el: HTMLElement, x: number, y: number, buttons = 0) =>
    fireEvent.pointerLeave(el, { clientX: x, clientY: y, buttons })
  const move = (x: number, y: number) =>
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }))
    })
  const aimed = (el: HTMLElement) => el.hasAttribute('data-aim')

  it('уход влево у низа ставит метку, и движение в самой точке выхода её не снимает', () => {
    const { getByTestId } = render(<Carrier />)
    const carrier = getByTestId('carrier')
    leave(carrier, 175, 380)
    move(175, 380)
    expect(aimed(carrier)).toBe(true)
    move(160, 330)
    move(140, 240)
    expect(aimed(carrier)).toBe(true)
  })

  it('стоящий в зоне курсор метку держит — таймера нет', () => {
    vi.useFakeTimers()
    const { getByTestId } = render(<Carrier />)
    const carrier = getByTestId('carrier')
    leave(carrier, 175, 300)
    act(() => vi.advanceTimersByTime(5000))
    expect(aimed(carrier)).toBe(true)
    vi.useRealTimers()
  })

  it('выход из зоны снимает метку сразу', () => {
    const { getByTestId } = render(<Carrier />)
    const carrier = getByTestId('carrier')
    leave(carrier, 175, 300)
    move(80, 300)
    expect(aimed(carrier)).toBe(false)
  })

  it('уход не влево (вниз) метку не ставит', () => {
    const { getByTestId } = render(<Carrier />)
    const carrier = getByTestId('carrier')
    leave(carrier, 400, 420)
    expect(aimed(carrier)).toBe(false)
  })

  it('возврат на носитель (или вход в кластер) снимает метку — дальше держит hover', () => {
    const { getByTestId } = render(<Carrier />)
    const carrier = getByTestId('carrier')
    leave(carrier, 175, 300)
    fireEvent.pointerEnter(carrier)
    expect(aimed(carrier)).toBe(false)
  })

  it('с зажатой кнопкой (жест) метки нет', () => {
    const { getByTestId } = render(<Carrier />)
    const carrier = getByTestId('carrier')
    leave(carrier, 175, 300, 1)
    expect(aimed(carrier)).toBe(false)
  })
})
