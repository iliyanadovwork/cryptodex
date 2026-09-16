import styles from '@/styles/common.module.css';
import { Container, Row, Col } from 'react-bootstrap';
import { useState, useEffect } from 'react';
import Mainnavbar from '../components/navbar';
import dynamic from 'next/dynamic';
//import component
// Phone/SMS password reset disabled
// const MobileForm = dynamic(() => import('../components/ForgotPassword/MobileForm'))
const EmailForm = dynamic(() => import('../components/ForgotPassword/EmailForm'))
export default function Forget() {
  return (
    <>
        <Mainnavbar />
        <div className={styles.login}>
          <Container>
            <Row>
              <Col lg={7} xxl={5} className="m-auto">
                <div className={styles.box_flx}>
                  <div className={`login_right ${styles.right_box} mx-auto`}>
                    <h2 className={styles.h2tag} >Forgot Password</h2>
                    {/* <p className={styles.info} >Withdrawals and OTC transfers will be unavailable for the next 24 hours once password is changed.</p> */}

                    {/* Phone/SMS password reset disabled - only email available */}
                    <EmailForm />

                  </div>
                </div>

              </Col>
            </Row>
          </Container>
        </div>

    </>

  )
}
