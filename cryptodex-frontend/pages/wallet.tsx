import styles from '@/styles/common.module.css';
import Mainnavbar from '../components/navbar';
import dynamic from 'next/dynamic';
//import component
const WalletList = dynamic(() => import('@/components/Wallet/WalletList'))
export default function Assets() {


  return (
    <>
      <Mainnavbar />
      <div className={styles.page_box}>
        <div className={styles.asset}>
          <WalletList />
        </div>
      </div>
    </>
  )
}
