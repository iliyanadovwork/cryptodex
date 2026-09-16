import styles from '@/styles/common.module.css';
import { Container, Row, Col } from 'react-bootstrap';
import { useState, useEffect } from 'react';
import Mainnavbar from '@/components/navbar';
import { useRouter } from "next/router";
import dynamic from 'next/dynamic'
//import component 
const Form = dynamic(() => import('../../components/ResetPassword/Form'))
//import lib
import isEmpty from '@/lib/isEmpty'

export default function Forget() {
    const [authToken, setAthToken] = useState<string>('');
    const { asPath } = useRouter()

    useEffect(() => {
        const tokn = asPath.split("/")[2]
        if (!isEmpty(tokn)) {
            setAthToken(tokn)
        }
    }, [asPath]);
    return (
        <>
                <Mainnavbar />
                <div className={styles.login}>
                    <Container>
                        <Row>
                            <Col lg={7} xxl={5} className="m-auto">
                                <div className={styles.box_flx}>
                                    <div className={`login_right ${styles.right_box} mx-auto`}>
                                        <h2 className={styles.h2tag} >Reset Password</h2>
                                        <Form authToken={authToken} />

                                    </div>
                                </div>

                            </Col>
                        </Row>
                    </Container>
                </div>

        </>

    )
}
