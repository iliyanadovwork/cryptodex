import Image from "next/image";
import styles from "@/styles/common.module.css";
import { Container, Row, Col } from "react-bootstrap";
//import component
// Phone/SMS registration disabled
// import MobileForm from "./MoblieForm";
import EmailForm from "./EmailForm";

export default function RegisterForm({ refId }: any) {
  return (
    <Container>
      <Row>
        <Col lg={7} xxl={5} className="m-auto">
          <div className={styles.box_flx}>
            <div className={`login_right ${styles.right_box}`}>
              <div className="text-center">
                <h2>Register</h2>
              </div>
              {/* Phone/SMS registration disabled - only email registration available */}
              <EmailForm refId={refId} />
            </div>
          </div>
        </Col>
      </Row>
    </Container>
  );
}
