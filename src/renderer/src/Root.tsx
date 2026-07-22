import App from './App'
import LookupApp from './LookupApp'

function Root(): React.JSX.Element {
  const isLookup = typeof window !== 'undefined' && window.location.search.includes('role=lookup')

  if (isLookup) {
    return <LookupApp />
  }
  return <App />
}

export default Root
