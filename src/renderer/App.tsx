import { useState, useEffect } from 'react'
import * as stylex from '@stylexjs/stylex'

const styles = stylex.create({
  heading: {
    fontSize: '2rem',
    fontWeight: 700,
    color: 'rebeccapurple',
  },
})

export default function App() {
  const [pingResult, setPingResult] = useState<string | null>(null)

  useEffect(() => {
    window.hearth.ping().then(r => {
      setPingResult(`Electron ${r.electron} / Node ${r.node}`)
    })
  }, [])

  return (
    <div>
      <h1 {...stylex.props(styles.heading)}>Hearth</h1>
      {pingResult && <p>{pingResult}</p>}
    </div>
  )
}
